import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from 'electron'
import { mkdir, stat, statfs } from 'node:fs/promises'
import { basename, join, relative } from 'path'
import { probe as probeAudio } from '../core/audio.ts'
import { EngineError } from '../core/errors.ts'
import { readJson } from '../core/files.ts'
import { defaultThreads, detect } from '../core/hardware.ts'
import { AUDIO_EXTS, NOTE_EXTS, pairInputs } from '../core/inputs.ts'
import { DEFAULT_MODEL } from '../core/job.ts'
import type { LlmSettings } from '../core/job.ts'
import { defaultDataDir, findFfmpeg, findWhisperCli } from '../core/paths.ts'
import { estimateSttSeconds } from '../core/probe.ts'
import type { ProbeResult } from '../core/probe.ts'
import { CREDITS_PER_90MIN_SUMMARY, PRESETS, PROVIDERS, verifyKey } from '../core/providers.ts'
import type { ProviderId } from '../core/providers.ts'
import { recentNotes } from '../core/recent.ts'
import { loadSettings, updateSettings } from '../core/settings.ts'
import type { Language } from '../core/settings.ts'
import { inspectFolder, useFolder } from '../core/vault.ts'
import { createJobRunner } from './jobs.ts'
import type { JobInput } from './jobs.ts'
import { fitContent } from './fit.ts'
import type { Size } from './fit.ts'
import { keyHint, readKey, saveKey } from './secrets.ts'
import { createSetup } from './setup.ts'

// 설치본은 extraResources로 넣은 resources/bin, 개발 중에는 저장소의 .cache/whisper/bin과 PATH의 ffmpeg.
const binDir = app.isPackaged ? join(process.resourcesPath, 'bin') : undefined
const whisperDirs = app.isPackaged
  ? [join(process.resourcesPath, 'bin', 'whisper')]
  : [join(app.getAppPath(), '..', '.cache', 'whisper', 'bin')]
const probeSample = app.isPackaged ? join(process.resourcesPath, 'probe-ko.wav') : join(app.getAppPath(), 'resources', 'probe-ko.wav')
// LN_DATA_DIR: 개발 중 첫 실행 상태를 따로 시험할 때만 쓴다 (CLI의 --data-dir과 같은 역할)
const dataDir = process.env['LN_DATA_DIR'] || defaultDataDir()

function found(find: () => string): string | null {
  try {
    return find()
  } catch {
    return null
  }
}

// 메인 → 화면 이벤트. 받는 쪽 허용 목록은 preload에 있다.
function emit(name: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('api:event', name, data)
}

const setup = createSetup({
  dataDir,
  whisperCli: () => findWhisperCli(whisperDirs),
  sample: probeSample,
  emit: (s) => {
    emit('setup', s)
    // 모델을 다 받고 속도 재기도 끝나면 기다리던 작업을 돌린다
    if (s.model.state === 'ready' && (s.probe.state === 'done' || s.probe.state === 'error')) runner.kick()
  }
})

/** 지금 모델로 잰 받아쓰기 속도 (probe.json) */
async function loadProbe(): Promise<ProbeResult | null> {
  try {
    const p = await readJson<ProbeResult>(join(dataDir, 'probe.json'))
    return p.model === DEFAULT_MODEL ? p : null
  } catch {
    return null
  }
}

async function outDir(): Promise<string> {
  const { outDir } = await loadSettings(dataDir)
  if (!outDir) throw new EngineError('input', '저장 폴더가 정해지지 않았어요.')
  return outDir
}

const runner = createJobRunner({
  dataDir,
  ffmpeg: () => findFfmpeg(binDir),
  whisperCli: () => findWhisperCli(whisperDirs),
  whenSttReady: () => setup.whenReady(),
  sttReady: () => {
    const s = setup.get()
    return s.model.state === 'ready' && (s.probe.state === 'done' || s.probe.state === 'error')
  },
  probe: loadProbe,
  defaultThreads: async () => defaultThreads(await detect()),
  llm: async (): Promise<LlmSettings | null> => {
    const { provider } = await loadSettings(dataDir)
    if (provider !== 'chatkhu' || !(await readKey(dataDir, provider))) return null
    const p = PRESETS['chatkhu']
    return { endpoint: p.endpoint, model: p.model, creditsUrl: p.credits }
  },
  apiKey: async () => {
    const { provider } = await loadSettings(dataDir)
    return provider ? readKey(dataDir, provider) : null
  },
  outDir,
  emit: (jobs) => emit('jobs', jobs)
})

type Prepared = {
  recordings: {
    audio: string
    name: string
    notes: string | null
    notesName: string | null
    durationS: number | null
    recordedAt: string
    /** 이 PC에서 받아쓰기 예상 시간(초). 속도를 아직 안 쟀으면 null */
    sttS: number | null
    /** 요약 예상 크레딧 (ChatKHU일 때만) */
    credits: number | null
  }[]
  rejected: { name: string; reason: string }[]
}

/** 시작 전 확인에 보여 줄 것: 녹음마다 길이·녹음 시각·예상 시간·예상 크레딧, 넣을 수 없는 파일과 이유. */
async function prepare(paths: string[]): Promise<Prepared> {
  const { recordings, ignored } = pairInputs(paths)
  const rejected = ignored.map((p) => ({
    name: basename(p),
    reason: NOTE_EXTS.some((e) => p.toLowerCase().endsWith('.' + e)) ? '같은 이름의 녹음이 없는 필기예요' : '녹음 파일이 아니에요'
  }))
  const [probe, settings] = await Promise.all([loadProbe(), loadSettings(dataDir)])
  const ffmpeg = findFfmpeg(binDir)
  const out: Prepared['recordings'] = []
  for (const r of recordings) {
    try {
      const info = await probeAudio(ffmpeg, r.audio)
      const meta = info.creationTime ? new Date(info.creationTime) : null
      const recordedAt =
        meta && !Number.isNaN(meta.getTime()) && meta.getFullYear() >= 2000 ? meta.toISOString() : (await stat(r.audio)).mtime.toISOString()
      out.push({
        audio: r.audio,
        name: basename(r.audio),
        notes: r.notes,
        notesName: r.notes ? basename(r.notes) : null,
        durationS: info.durationS,
        recordedAt,
        sttS: probe && info.durationS ? Math.round(estimateSttSeconds(info.durationS, probe)) : null,
        credits: settings.provider === 'chatkhu' && info.durationS ? Math.max(1, Math.round((info.durationS / 5400) * CREDITS_PER_90MIN_SUMMARY)) : null
      })
    } catch {
      rejected.push({ name: basename(r.audio), reason: '소리를 읽을 수 없는 파일이에요' })
    }
  }
  return { recordings: out, rejected }
}

/** 저장 폴더 안의 .md만 연다 (화면이 임의의 파일을 열지 못하게). */
async function openNote(path: string): Promise<void> {
  const rel = relative(await outDir(), path)
  if (!path.toLowerCase().endsWith('.md') || rel.startsWith('..') || rel === path) throw new EngineError('input', '저장 폴더의 노트만 열 수 있어요.')
  const err = await shell.openPath(path)
  if (err) throw new EngineError('input', '노트를 열지 못했어요: ' + err)
}

function providerOf(id: unknown): ProviderId {
  const p = PROVIDERS.find((x) => x.id === id && x.available)
  if (!p) throw new EngineError('input', '아직 지원하지 않는 요약 서비스예요.')
  return p.id
}

async function llmStatus(): Promise<{ provider: ProviderId | null; name?: string; keyHint?: string; credits?: number | null; summariesLeft?: number | null }> {
  const { provider } = await loadSettings(dataDir)
  const key = provider ? await readKey(dataDir, provider) : null
  if (!provider || !key) return { provider: null }
  // 잔액은 참고용이라 못 불러와도(오프라인) 연결 상태는 그대로 보인다.
  const credits = await verifyKey(provider, key).then((r) => r.credits, () => null)
  return {
    provider,
    name: PROVIDERS.find((x) => x.id === provider)?.name,
    keyHint: keyHint(key),
    credits,
    summariesLeft: credits == null ? null : Math.floor(credits / CREDITS_PER_90MIN_SUMMARY)
  }
}

// 화면이 부를 수 있는 처리 (허용 목록).
const handlers: Record<string, (params: unknown) => unknown> = {
  ping: () => ({
    version: app.getVersion(),
    whisperCli: found(() => findWhisperCli(whisperDirs)),
    ffmpeg: found(() => findFfmpeg(binDir))
  }),

  'settings.get': () => loadSettings(dataDir),
  // 화면이 직접 바꿀 수 있는 것은 마법사 진행 상태뿐이다. 폴더와 요약 서비스는 검사를 거치는 전용 메서드로 바꾼다.
  'settings.setWizard': async (p) => {
    const { step, done } = p as { step?: number; done?: boolean }
    const settings = await updateSettings(dataDir, {
      ...(Number.isInteger(step) ? { wizardStep: step } : {}),
      ...(typeof done === 'boolean' ? { wizardDone: done } : {})
    })
    // 마법사를 끝내면 창을 홈 크기로 키운다
    if (done && mainWindow) resizeContent(mainWindow, HOME_CONTENT)
    return settings
  },

  'system.info': async () => {
    await mkdir(dataDir, { recursive: true })
    const [hw, fs] = await Promise.all([detect(), statfs(dataDir)])
    return { cpu: hw.cpu, cores: hw.physicalCores, ramGb: hw.ramGb, freeBytes: fs.bavail * fs.bsize }
  },

  'setup.get': () => setup.get(),
  'setup.download': () => {
    void setup.download()
    return setup.get()
  },

  'llm.providers': () => PROVIDERS.map(({ id, name, available }) => ({ id, name, available })),
  'llm.status': () => llmStatus(),
  // 키를 확인하고, 맞으면 암호화해 저장한 뒤 이 서비스를 연결한다.
  'llm.connect': async (p) => {
    const { provider, key } = p as { provider: unknown; key: unknown }
    const id = providerOf(provider)
    const apiKey = String(key ?? '').trim()
    if (!apiKey) throw new EngineError('auth', '키를 붙여 넣어 주세요.')
    const { credits } = await verifyKey(id, apiKey)
    await saveKey(dataDir, id, apiKey)
    await updateSettings(dataDir, { provider: id })
    return { provider: id, keyHint: keyHint(apiKey), credits, summariesLeft: credits === null ? null : Math.floor(credits / CREDITS_PER_90MIN_SUMMARY) }
  },
  'llm.openKeyGuide': (p) => {
    const url = PROVIDERS.find((x) => x.id === p)?.keyGuideUrl
    // 목록에 있는 http(s) 주소만 연다.
    if (url?.startsWith('https://')) void shell.openExternal(url)
  },

  'folder.default': () => join(app.getPath('documents'), '강의 노트'),
  'folder.pick': async (p) => {
    const win = BrowserWindow.getFocusedWindow()
    const opts = { defaultPath: typeof p === 'string' ? p : undefined, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : r.filePaths[0]
  },
  'folder.inspect': (p) => inspectFolder(String(p)),
  'folder.use': async (p) => {
    const info = await useFolder(String(p))
    await updateSettings(dataDir, { outDir: info.path })
    return info
  },
  'folder.openOut': async () => {
    const err = await shell.openPath(await outDir())
    if (err) throw new EngineError('input', '폴더를 열지 못했어요: ' + err)
  },

  'inputs.pick': async () => {
    const win = BrowserWindow.getFocusedWindow()
    const opts = {
      properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
      filters: [{ name: '녹음과 필기', extensions: [...AUDIO_EXTS, ...NOTE_EXTS] }]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? [] : r.filePaths
  },
  'inputs.prepare': (p) => prepare((p as unknown[]).map(String)),
  // 과목 목록(저장 폴더의 하위 폴더), 마지막 과목, 과목별 강의 언어
  'subjects.get': async () => {
    const s = await loadSettings(dataDir)
    const info = await inspectFolder(await outDir())
    return { subjects: info.subjects, lastSubject: s.lastSubject, subjectLanguage: s.subjectLanguage }
  },

  'jobs.list': () => runner.list(),
  'jobs.start': async (p) => {
    const items: JobInput[] = (p as JobInput[]).map((i) => ({
      audio: String(i.audio),
      notes: i.notes ? String(i.notes) : null,
      subject: i.subject ? String(i.subject).trim() || null : null,
      language: (i.language === 'en' ? 'en' : 'ko') as Language
    }))
    if (!items.length) throw new EngineError('input', '넣은 녹음이 없어요.')
    await updateSettings(dataDir, { lastSubject: items[0].subject })
    await runner.start(items)
  },
  'jobs.retry': (p) => runner.retry(String(p)),

  'notes.recent': async () => recentNotes(await outDir()),
  'notes.open': (p) => openNote(String(p))
}

// 창의 화면 영역(창 틀·메뉴 줄 제외)은 4:3. 마법사는 최소 크기로 열고, 끝나면 홈 크기로 키운다.
const ASPECT = 4 / 3
const MIN_CONTENT: Size = { width: 800, height: 600 }
const WIZARD_CONTENT: Size = MIN_CONTENT
const HOME_CONTENT: Size = { width: 1000, height: 750 }

let mainWindow: BrowserWindow | null = null

/** 화면 영역을 target으로 바꾸되, 창 틀까지 모니터 작업 영역에 들어가게 줄이고 가운데에 둔다. */
function resizeContent(win: BrowserWindow, target: Size): void {
  const outer = win.getBounds()
  const inner = win.getContentBounds()
  const frame = { width: outer.width - inner.width, height: outer.height - inner.height }
  const size = fitContent(target, screen.getDisplayMatching(outer).workArea, frame, ASPECT, MIN_CONTENT)
  win.setContentSize(size.width, size.height)
  win.center()
}

// 창 크기를 바꿀 때 화면 영역(창 틀·메뉴 줄 제외)을 4:3으로 맞춘다.
// Windows의 setAspectRatio는 창 틀까지 포함한 크기에 비율을 맞춰서 화면 영역 비율이 틀어진다.
function keepContentAspect(win: BrowserWindow): void {
  win.on('will-resize', (event, next, { edge }) => {
    const outer = win.getBounds()
    const inner = win.getContentBounds()
    const frameW = outer.width - inner.width
    const frameH = outer.height - inner.height
    let w = next.width - frameW
    let h = next.height - frameH
    if (edge === 'bottom') w = Math.round(h * ASPECT)
    else h = Math.round(w / ASPECT)
    if (w < MIN_CONTENT.width || h < MIN_CONTENT.height) ({ width: w, height: h } = MIN_CONTENT)
    const width = w + frameW
    const height = h + frameH
    event.preventDefault()
    // 끄는 쪽의 반대편 모서리는 제자리에 둔다
    win.setBounds({
      x: edge.includes('left') ? outer.x + outer.width - width : outer.x,
      y: edge.includes('top') ? outer.y + outer.height - height : outer.y,
      width,
      height
    })
  })
}

function createWindow(target: Size): void {
  const win = new BrowserWindow({
    width: target.width,
    height: target.height,
    minWidth: MIN_CONTENT.width,
    minHeight: MIN_CONTENT.height,
    useContentSize: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })
  keepContentAspect(win)
  resizeContent(win, target)
  mainWindow = win
  win.on('closed', () => (mainWindow = null))
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  ipcMain.handle('api:call', async (_event, method: string, params: unknown) => {
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
    if (!handler) throw new Error(`허용되지 않은 메서드: ${method}`)
    try {
      return await handler(params)
    } catch (e) {
      // IPC는 Error의 추가 필드를 버리므로, 화면이 고를 수 있게 코드를 메시지 앞에 붙인다.
      if (e instanceof EngineError) throw new Error(`[${e.code}] ${e.message}`)
      throw e
    }
  })
  void setup.init()
  runner.kick() // 앱이 꺼져 멈췄던 작업을 이어서 한다
  // 설치본에는 기본 메뉴 줄(File·Edit·View…)을 두지 않는다. 개발 실행에서는 새로 고침·개발자 도구 단축키 때문에 남긴다.
  if (app.isPackaged) Menu.setApplicationMenu(null)
  createWindow((await loadSettings(dataDir)).wizardDone ? HOME_CONTENT : WIZARD_CONTENT)
})

app.on('window-all-closed', () => {
  app.quit()
})
