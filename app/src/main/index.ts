import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, statfs } from 'node:fs/promises'
import { basename, join, relative } from 'path'
import { probe as probeAudio } from '../core/audio.ts'
import { PRODUCT_NAME } from '../core/brand.ts'
import { EngineError } from '../core/errors.ts'
import { dirSize, readJson } from '../core/files.ts'
import { defaultThreads, detect } from '../core/hardware.ts'
import { AUDIO_EXTS, NOTE_EXTS, pairInputs } from '../core/inputs.ts'
import { DEFAULT_BEAM_SIZE, DEFAULT_MODEL, jobsDir, listJobs, STT_MODEL_CHOICES, VAD_MODEL } from '../core/job.ts'
import type { LlmSettings } from '../core/job.ts'
import { MODELS } from '../core/models.ts'
import { defaultDataDir, findFfmpeg, findWhisperCli } from '../core/paths.ts'
import { estimateJobSeconds, estimateSttSeconds, testSample } from '../core/probe.ts'
import type { ProbeResult } from '../core/probe.ts'
import { DEFAULT_STEP_MODEL, estimateCredits90, estimateStepCredits90, POLISH_RECOMMENDED, RANKED, RECOMMENDED_COUNT } from '../core/llmcatalog.ts'
import type { ModelItem } from '../core/llmcatalog.ts'
import { CREDITS_PER_90MIN_SUMMARY, creditsPer90ByModel, listModels, PRESETS, PROVIDERS, verifyKey } from '../core/providers.ts'
import type { ProviderId } from '../core/providers.ts'
import { listNotes, recentNotes } from '../core/recent.ts'
import { loadSettings, updateSettings } from '../core/settings.ts'
import { checkArgs } from '../core/stt/whispercpp.ts'
import { defaultArgs, parseArgs, previewCommand } from '../core/sttargs.ts'
import type { Language, Settings, Theme } from '../core/settings.ts'
import { inspectFolder, useFolder } from '../core/vault.ts'
import { createJobRunner } from './jobs.ts'
import type { JobInput, JobView } from './jobs.ts'
import { fitContent } from './fit.ts'
import type { Size } from './fit.ts'
import { createLog } from './log.ts'
import { keyHint, readKey, removeKey, saveKey } from './secrets.ts'
import { createSetup } from './setup.ts'
import { createTray } from './tray.ts'

// 설치본은 extraResources로 넣은 resources/bin, 개발 중에는 저장소의 .cache/whisper/bin과 PATH의 ffmpeg.
const binDir = app.isPackaged ? join(process.resourcesPath, 'bin') : undefined
const whisperDirs = app.isPackaged
  ? [join(process.resourcesPath, 'bin', 'whisper')]
  : [join(app.getAppPath(), '..', '.cache', 'whisper', 'bin')]
const probeSample = app.isPackaged ? join(process.resourcesPath, 'probe-ko.wav') : join(app.getAppPath(), 'resources', 'probe-ko.wav')
// LN_DATA_DIR: 개발 중 첫 실행 상태를 따로 시험할 때만 쓴다 (CLI의 --data-dir과 같은 역할)
const dataDir = process.env['LN_DATA_DIR'] || defaultDataDir()
const log = createLog(join(dataDir, 'logs'))
const RELEASES_URL = 'https://github.com/jeongho30/lecture-notes/releases'

// 앱은 하나만 띄운다: 두 번째로 실행하면 이미 떠 있는 창을 앞으로 가져온다 (같은 설정·작업 파일을 두 곳에서 쓰지 않게)
const primary = app.requestSingleInstanceLock()
if (!primary) app.quit()

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
  model: DEFAULT_MODEL, // 앱을 켤 때 settings.json의 모델로 바꾼다 (init)
  whisperCli: () => findWhisperCli(whisperDirs),
  sample: probeSample,
  busy: () => runner.transcribing(),
  log: log.write,
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
    return p.model === setup.model() ? p : null
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
  stt: async () => {
    const { sttArgs } = await loadSettings(dataDir)
    return { model: setup.model(), args: sttArgs ? parseArgs(sttArgs) : null }
  },
  llm: async (): Promise<LlmSettings | null> => {
    const { provider, summaryModel } = await loadSettings(dataDir)
    if (provider !== 'chatkhu' || !(await readKey(dataDir, provider))) return null
    const p = PRESETS['chatkhu']
    return { endpoint: p.endpoint, model: summaryModel ?? p.model, creditsUrl: p.credits }
  },
  steps: async () => {
    const { polishModel } = await loadSettings(dataDir)
    return { polishModel }
  },
  apiKey: async () => {
    const { provider } = await loadSettings(dataDir)
    return provider ? readKey(dataDir, provider) : null
  },
  outDir,
  emit: (jobs) => {
    emit('jobs', jobs)
    onJobs(jobs)
    if (!runner.transcribing()) setup.resume() // 작업 때문에 미룬 속도 재기
  }
})

// ── 창 닫기와 트레이 ──
// 작업(대기 포함)이 있을 때 창을 닫으면 트레이로 숨어 계속하고, 없으면 앱을 끝낸다(9/28 결정).
let quitting = false
let closeHintShown = false
let lastJobs: JobView[] = []
let seenStatus = new Map<string, JobView['status']>()

const tray = createTray({ open: showWindow, quit: () => void quitFromTray() })

function showWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  updateTray()
}

/** 작업 중이거나 창이 숨어 있으면 트레이를 두고, 아니면 없앤다. */
function updateTray(): void {
  const active = lastJobs.filter((j) => j.status === 'running' || j.status === 'queued')
  const hidden = !!mainWindow && !mainWindow.isVisible()
  if (!active.length && !hidden) return tray.destroy()
  tray.ensure()
  const run = active.find((j) => j.status === 'running' && j.stage)
  const waiting = active.length - (run ? 1 : 0)
  tray.status(
    [PRODUCT_NAME, run ? `${run.name} ${run.stage === 'stt' ? `받아쓰기 ${Math.floor(run.frac * 100)}%` : '처리 중'}` : null, waiting ? `대기 ${waiting}개` : null]
      .filter(Boolean)
      .join(' · ')
  )
}

// 작업 상태가 바뀔 때마다 기록에 남긴다 (앱을 켠 뒤 처음 받은 목록은 남기지 않음)
let loggedStatus: Map<string, JobView['status']> | null = null
const STATUS_WORD: Record<JobView['status'], string> = { queued: '대기', running: '시작', done: '완료', failed: '실패', cancelled: '취소' }

function logJobs(jobs: JobView[]): void {
  const prev = loggedStatus
  loggedStatus = new Map(jobs.map((j) => [j.id, j.status]))
  if (!prev) return
  for (const j of jobs) {
    if (prev.get(j.id) === j.status) continue
    const why = j.status === 'failed' && j.error ? ` · ${j.error.stage} · [${j.error.code}] ${j.error.message}` : ''
    log.write(`작업 ${STATUS_WORD[j.status]}: ${j.name}${why}`)
  }
}

function onJobs(jobs: JobView[]): void {
  logJobs(jobs)
  // 창이 숨어 있는 동안 끝나거나 실패한 작업은 트레이 알림으로 알린다 (창이 보이면 화면이 알린다)
  if (mainWindow && !mainWindow.isVisible()) {
    for (const j of jobs) {
      const before = seenStatus.get(j.id)
      if (before !== 'running' && before !== 'queued') continue
      // 알림을 누르면 완료는 노트 미리보기, 실패는 작업 목록을 연다
      const note = j.notePath
      if (j.status === 'done') tray.notify('노트가 만들어졌어요', `${j.subject ?? '미분류'} · ${j.name}`, () => navigate(note ? { view: 'preview', path: note } : { view: 'home' }))
      if (j.status === 'failed') tray.notify('노트를 만들지 못했어요', `${j.name} · ${j.error?.message.split('\n')[0] ?? ''}`, () => navigate({ view: 'jobs' }))
    }
  }
  seenStatus = new Map(jobs.map((j) => [j.id, j.status]))
  lastJobs = jobs
  updateTray()
}

/** 창을 보이고 화면을 옮긴다 (트레이 알림을 눌렀을 때) */
function navigate(to: { view: 'home' | 'jobs' } | { view: 'preview'; path: string }): void {
  showWindow()
  emit('navigate', to)
}

async function quitFromTray(): Promise<void> {
  if (runner.activeCount() > 0) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: PRODUCT_NAME,
      message: '받아쓰기 중이에요',
      detail: '끝내면 지금 작업이 멈추고, 다음에 앱을 켜면 멈춘 곳부터 이어서 해요.',
      buttons: ['계속하기', '끝내기'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (response !== 1) return
  }
  quitting = true
  app.quit()
}

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
    /** 오디오 준비부터 노트 저장까지 예상 시간(초). 속도를 아직 안 쟀으면 null */
    totalS: number | null
  }[]
  rejected: { name: string; reason: string }[]
}

/** 지금 고른 요약 모델의 90분 요약 크레딧. 써 본 적 없는 모델이면 null */
async function selectedModelCredits90(): Promise<number | null> {
  const { summaryModel } = await loadSettings(dataDir)
  const model = summaryModel ?? PRESETS['chatkhu'].model
  return creditsPer90ByModel(await listJobs(dataDir))[model] ?? estimateCredits90(model)
}

/**
 * 90분 강의 한 개의 크레딧: 요약 + 전사문 다듬기(켠 경우).
 * polish: false면 다듬기를 빼고 센다 ([요약 다시 만들기]는 다시 다듬지 않는다)
 */
async function jobCredits90({ polish = true } = {}): Promise<number> {
  const { polishModel } = await loadSettings(dataDir)
  const summary = (await selectedModelCredits90()) ?? CREDITS_PER_90MIN_SUMMARY
  const polished = polish && !!polishModel
  const polishCredits = polished ? (estimateStepCredits90('polish', polishModel!) ?? 0) : 0
  return summary + polishCredits
}

/** 남은 크레딧으로 90분 강의를 몇 개 더 요약할 수 있는지 */
async function summariesLeft(credits: number | null): Promise<number | null> {
  if (credits == null) return null
  return Math.floor(credits / (await jobCredits90()))
}

/** 시작 전 확인에 보여 줄 것: 녹음마다 길이·녹음 시각·예상 시간·예상 크레딧, 넣을 수 없는 파일과 이유. */
async function prepare(paths: string[]): Promise<Prepared> {
  const { recordings, ignored } = pairInputs(paths)
  const rejected = ignored.map((p) => ({
    name: basename(p),
    reason: NOTE_EXTS.some((e) => p.toLowerCase().endsWith('.' + e)) ? '같은 이름의 녹음이 없는 필기예요' : '녹음 파일이 아니에요'
  }))
  const [probe, settings, per90] = await Promise.all([loadProbe(), loadSettings(dataDir), jobCredits90()])
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
        totalS: probe && info.durationS ? Math.round(estimateJobSeconds(info.durationS, probe, settings.provider !== null)) : null,
        credits: settings.provider === 'chatkhu' && info.durationS ? Math.max(1, Math.round((info.durationS / 5400) * per90)) : null
      })
    } catch {
      rejected.push({ name: basename(r.audio), reason: '소리를 읽을 수 없는 파일이에요' })
    }
  }
  return { recordings: out, rejected }
}

/** 저장 폴더 안의 .md만 연다 (화면이 임의의 파일을 열지 못하게). */
async function checkNotePath(path: string): Promise<string> {
  const rel = relative(await outDir(), path)
  if (!path.toLowerCase().endsWith('.md') || rel.startsWith('..') || rel === path) throw new EngineError('input', '저장 폴더의 노트만 열 수 있어요.')
  return path
}

async function openNote(path: string): Promise<void> {
  const err = await shell.openPath(await checkNotePath(path))
  if (err) throw new EngineError('input', '노트를 열지 못했어요: ' + err)
}

const samePath = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

/** 노트 미리보기: .md 내용과, 이 노트를 만든 작업(요약을 다시 만들 수 있는지). 작업 기록을 지웠으면 job은 null. */
async function readNote(path: string) {
  const checked = await checkNotePath(path)
  let markdown: string
  try {
    markdown = await readFile(checked, 'utf8')
  } catch {
    throw new EngineError('input', '노트 파일을 찾지 못했어요. 옮기거나 지웠을 수 있어요.')
  }
  const [folder, jobs, per90] = await Promise.all([inspectFolder(await outDir()), listJobs(dataDir), jobCredits90({ polish: false })])
  const job = jobs.filter((j) => j.output?.notePath && samePath(j.output.notePath, checked)).at(-1) ?? null
  const durationS = job?.audio?.durationS ?? null
  return {
    path: checked,
    markdown,
    vault: folder.vaultRoot !== null,
    job: job && {
      id: job.id,
      durationS,
      // 받아쓰기·정리까지 끝난 작업이면 요약부터 다시 할 수 있다
      canSummarize: job.stages.clean.status === 'done',
      credits: durationS ? Math.max(1, Math.round((durationS / 5400) * per90)) : null
    }
  }
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
    summariesLeft: await summariesLeft(credits)
  }
}

const modelFile = (name: string): string => join(dataDir, 'models', MODELS.whisper[name].file)
const vadFile = (): string => join(dataDir, 'models', MODELS.vad[VAD_MODEL].file)

/** 받아쓰기 모델을 다 받았는지 (.part가 아니라 완성본이 제 크기인지) */
async function haveModel(name: string): Promise<boolean> {
  return stat(modelFile(name)).then((s) => s.size === MODELS.whisper[name].size, () => false)
}

/** 설정 > 고급 > 받아쓰기 세부설정에 보여 줄 것 */
async function sttOptions() {
  const settings = await loadSettings(dataDir)
  const probe = setup.get().probe
  const defaults = defaultArgs({
    threads: probe.threads ?? defaultThreads(await detect()),
    beamSize: DEFAULT_BEAM_SIZE,
    gpuDevice: probe.gpuDevice ?? null,
    vad: true
  }).join(' ')
  const choices = await Promise.all(
    STT_MODEL_CHOICES.map(async (id) => ({
      id,
      size: MODELS.whisper[id].size,
      downloaded: await haveModel(id),
      // 명령 중 앱이 정하는 부분 (강의 언어는 과목마다 달라 한국어로 보인다)
      locked: previewCommand(MODELS.whisper[id].file, MODELS.vad[VAD_MODEL].file, 'ko', []).locked
    }))
  )
  return { model: setup.model(), choices, defaultArgs: defaults, args: settings.sttArgs ?? defaults, custom: settings.sttArgs !== null }
}

/** 고른 모델과 옵션을 검사한다. 옵션은 whisper-cli에 한 번 읽혀 봐서 모르는 옵션·빠진 값을 저장 전에 거른다. */
async function sttInput(p: unknown): Promise<{ model: string; args: string[] }> {
  const { model, args } = p as { model: unknown; args: unknown }
  const name = String(model)
  if (!(STT_MODEL_CHOICES as readonly string[]).includes(name)) throw new EngineError('input', '고를 수 없는 모델이에요.')
  const parsed = parseArgs(String(args ?? ''))
  if (!parsed.length) throw new EngineError('input', '옵션이 비었어요. [기본값으로 되돌리기]를 눌러 주세요.')
  const problem = await checkArgs([findWhisperCli(whisperDirs)], parsed)
  if (problem) throw new EngineError('input', `whisper-cli가 이 옵션을 받지 않아요: ${problem}`)
  return { model: name, args: parsed }
}

async function openFolder(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  const err = await shell.openPath(path)
  if (err) throw new EngineError('input', '폴더를 열지 못했어요: ' + err)
}

/** 오픈소스 고지. 개발 중에는 scripts/notices.mjs로 만든 build/의 파일을 연다 */
async function openNotices(): Promise<void> {
  const path = app.isPackaged ? join(process.resourcesPath, 'THIRD_PARTY_NOTICES.txt') : join(app.getAppPath(), 'build', 'THIRD_PARTY_NOTICES.txt')
  if (!existsSync(path)) throw new EngineError('input', '오픈소스 고지 파일이 없어요.')
  const err = await shell.openPath(path)
  if (err) throw new EngineError('input', '파일을 열지 못했어요: ' + err)
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
    return { provider: id, keyHint: keyHint(apiKey), credits, summariesLeft: await summariesLeft(credits) }
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
  'jobs.transcriptOnly': (p) => runner.transcriptOnly(String(p)),
  'jobs.cancel': (p) => runner.cancel(String(p)),
  'jobs.remove': (p) => runner.remove(String(p)),
  // 끝난 작업의 노트를 폴더에서 보기 (경로는 화면이 아니라 job.json에서 가져온다)
  'jobs.revealNote': async (p) => {
    const path = await runner.notePath(String(p))
    if (!path) throw new EngineError('input', '노트를 찾지 못했어요.')
    shell.showItemInFolder(path)
  },

  // ── 설정 화면 ──
  // 화면 색: Electron이 prefers-color-scheme와 창 제목 줄을 함께 바꾼다
  'settings.setTheme': async (p) => {
    const theme: Theme = p === 'light' || p === 'dark' ? p : 'system'
    nativeTheme.themeSource = theme
    await updateSettings(dataDir, { theme })
    return theme
  },
  'settings.setSubjectLanguage': async (p) => {
    const { subject, language } = p as { subject: unknown; language: unknown }
    const s = await loadSettings(dataDir)
    const next: Record<string, Language> = { ...s.subjectLanguage, [String(subject)]: language === 'en' ? 'en' : 'ko' }
    return (await updateSettings(dataDir, { subjectLanguage: next })).subjectLanguage
  },

  'llm.disconnect': async () => {
    const { provider } = await loadSettings(dataDir)
    if (provider) await removeKey(dataDir, provider)
    await updateSettings(dataDir, { provider: null })
    log.write('요약 서비스 연결 끊음')
  },
  // 요약 모델과 모델별 90분 요약 크레딧: 써 본 기록(measured)이 있으면 그것, 없으면 단가표로 어림(estimate).
  // 보이는 것은 추천 순서(RANKED)의 모델과 고른 모델뿐이다. available은 [직접 모델 입력]의 확인용(서비스의 글 모델 전체).
  'llm.models': async () => {
    const { provider, summaryModel } = await loadSettings(dataDir)
    const recommended = PRESETS['chatkhu'].model
    const selected = summaryModel ?? recommended
    const key = provider ? await readKey(dataDir, provider) : null
    let items: ModelItem[] = []
    let failed = false
    if (provider && key) items = await listModels(provider, key).catch(() => ((failed = true), []))
    const measured = creditsPer90ByModel(await listJobs(dataDir))
    const owners = new Map(items.map((m) => [m.id, m.owner]))
    const available = new Set(items.map((m) => m.id))
    // 목록을 불러왔으면 목록에 없는 모델은 뺀다 (서비스에서 내려간 모델)
    const ranked = RANKED.filter((r) => failed || !items.length || available.has(r.id))
    const ids = [...new Set([...ranked.map((r) => r.id), selected])]
    return {
      selected,
      recommended,
      failed,
      available: [...available],
      models: ids.map((id) => {
        const rank = RANKED.findIndex((x) => x.id === id)
        const estimate = estimateCredits90(id)
        return {
          id,
          owner: owners.get(id) ?? null,
          rank: rank >= 0 ? rank + 1 : null,
          recommended: rank >= 0 && rank < RECOMMENDED_COUNT,
          note: RANKED[rank]?.note || null,
          credits90: measured[id] ?? estimate,
          source: measured[id] != null ? 'measured' : estimate != null ? 'estimate' : null
        }
      })
    }
  },
  'llm.setModel': async (p) => {
    const model = String(p ?? '').trim()
    if (!model) throw new EngineError('input', '모델을 골라 주세요.')
    await updateSettings(dataDir, { summaryModel: model === PRESETS['chatkhu'].model ? null : model })
    log.write(`요약 모델: ${model}`)
  },
  // 설정 > 고급 > 요약 세부설정: 전사문 다듬기 모델. llm.models와 같은 형식으로, 다듬기 추천 모델을 앞에 두고 나머지는 요약 추천 순서
  'llm.steps': async () => {
    const { provider, polishModel } = await loadSettings(dataDir)
    const key = provider ? await readKey(dataDir, provider) : null
    let items: ModelItem[] = []
    let failed = false
    if (provider && key) items = await listModels(provider, key).catch(() => ((failed = true), []))
    const owners = new Map(items.map((m) => [m.id, m.owner]))
    const available = new Set(items.map((m) => m.id))
    const order = [...new Set([...POLISH_RECOMMENDED, ...RANKED.map((r) => r.id)])].filter((id) => failed || !items.length || available.has(id))
    const ids = [...new Set([...order, ...(polishModel ? [polishModel] : [])])]
    return {
      polishModel,
      defaultModel: DEFAULT_STEP_MODEL,
      failed,
      available: [...available],
      models: ids.map((id) => {
        const rank = order.indexOf(id)
        const credits90 = estimateStepCredits90('polish', id)
        return {
          id,
          owner: owners.get(id) ?? null,
          rank: rank >= 0 ? rank + 1 : null,
          recommended: POLISH_RECOMMENDED.includes(id),
          note: null,
          credits90,
          source: credits90 != null ? 'estimate' : null
        }
      })
    }
  },
  'llm.setSteps': async (p) => {
    const { polishModel } = (p ?? {}) as { polishModel?: unknown }
    const patch: Partial<Settings> = {}
    if (polishModel !== undefined) {
      if (polishModel !== null && (typeof polishModel !== 'string' || !polishModel.trim())) throw new EngineError('input', '다듬기 모델을 골라 주세요.')
      patch.polishModel = polishModel === null ? null : polishModel.trim()
    }
    await updateSettings(dataDir, patch)
    log.write(`요약 세부설정: ${JSON.stringify(patch)}`)
  },

  'setup.reprobe': () => {
    setup.reprobe()
    return setup.get()
  },

  'stt.options': () => sttOptions(),
  // 고친 옵션으로 샘플을 한 번 전사해 본다 (저장하지 않음)
  'stt.test': async (p) => {
    const { model, args } = await sttInput(p)
    if (!(await haveModel(model))) throw new EngineError('input', '이 모델을 받은 뒤 시험할 수 있어요. [저장]하면 받아요.')
    if (runner.transcribing()) throw new EngineError('input', '받아쓰기 중에는 시험할 수 없어요. 작업이 끝난 뒤 해 주세요.')
    if (setup.get().probe.state === 'running') throw new EngineError('input', '속도를 재는 중이에요. 끝난 뒤 시험해 주세요.')
    const scriptPath = probeSample.replace(/\.wav$/, '.txt')
    // 대본 파일의 첫 빈 줄 뒤가 읽은 글이다
    const script = existsSync(scriptPath) ? (await readFile(scriptPath, 'utf8')).split(/\r?\n\r?\n/).slice(1).join(' ') || null : null
    const result = await testSample({
      cli: [findWhisperCli(whisperDirs)],
      model: modelFile(model),
      vadModel: vadFile(),
      args,
      language: 'ko',
      sample: probeSample,
      script,
      workDir: join(dataDir, 'probe-test')
    })
    log.write(`샘플 시험: ${model} · ${args.join(' ')} · ${result.processS.toFixed(1)}초 · ${result.ok ? '정상' : result.reason}`)
    return result
  },
  // 모델과 옵션을 저장한다. 모델을 바꾸면 받은 뒤 속도를 다시 잰다. 기본 옵션과 같으면 기본으로 둔다(장치가 바뀌면 따라가게).
  'stt.save': async (p) => {
    const { model, args } = await sttInput(p)
    const text = args.join(' ')
    const { defaultArgs: defaults } = await sttOptions()
    await updateSettings(dataDir, { sttModel: model, sttArgs: text === defaults ? null : text })
    await setup.setModel(model)
    log.write(`받아쓰기 설정: ${model} · ${text === defaults ? '기본 옵션' : text}`)
    return sttOptions()
  },

  'storage.info': async () => {
    const jobs = await listJobs(dataDir)
    const downloaded = []
    for (const id of Object.keys(MODELS.whisper)) if (await haveModel(id)) downloaded.push(id)
    return {
      modelsBytes: await dirSize(join(dataDir, 'models')),
      models: downloaded,
      jobsBytes: await dirSize(jobsDir(dataDir)),
      done: jobs.filter((j) => j.status === 'done').length,
      stopped: jobs.filter((j) => j.status === 'failed' || j.status === 'cancelled').length
    }
  },
  'jobs.clearDone': async () => {
    const n = await runner.clearDone()
    log.write(`완료한 작업 기록 ${n}개 지움`)
    return n
  },

  'app.openData': () => openFolder(dataDir),
  'app.openLogs': () => openFolder(log.dir),
  'app.openNotices': () => openNotices(),
  'app.openReleases': () => void shell.openExternal(RELEASES_URL),

  'notes.recent': async () => recentNotes(await outDir()),
  'notes.list': async () => listNotes(await outDir()),
  'notes.open': (p) => openNote(String(p)),
  'notes.read': (p) => readNote(String(p)),
  'notes.reveal': async (p) => shell.showItemInFolder(await checkNotePath(String(p))),
  // 저장 폴더가 옵시디언 볼트일 때만 화면이 부른다
  'notes.openObsidian': async (p) => {
    await shell.openExternal(`obsidian://open?path=${encodeURIComponent(await checkNotePath(String(p)))}`)
  },
  // 노트 안의 링크는 창 안에서 열지 않고 브라우저로 (http·https만)
  'notes.openLink': (p) => {
    const url = String(p)
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  },
  'jobs.resummarize': async (p) => {
    await runner.resummarize(String(p))
    log.write(`요약 다시 만들기: ${p}`)
  }
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
  win.on('close', (event) => {
    if (quitting || runner.activeCount() === 0) return
    event.preventDefault()
    win.hide()
    updateTray()
    if (!closeHintShown) {
      closeHintShown = true
      tray.notify('창을 닫아도 계속해요', '받아쓰기가 끝나면 알려 드려요. 작업 표시줄 오른쪽 아이콘으로 다시 열 수 있어요.')
    }
  })
  win.on('show', updateTray)
  // Windows 로그아웃·종료 때는 트레이로 숨지 않고 끝낸다
  win.on('query-session-end', () => {
    quitting = true
  })
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.on('second-instance', showWindow)

// 끝낼 때 돌고 있는 받아쓰기(whisper-cli)를 멈추고 작업을 대기로 되돌린다. 다음에 켜면 이어서 한다.
let stopped = false
app.on('before-quit', (event) => {
  quitting = true
  if (stopped || !runner.busy()) return
  event.preventDefault()
  void runner.shutdown().finally(() => {
    stopped = true
    app.quit()
  })
})

app.whenReady().then(async () => {
  if (!primary) return
  ipcMain.handle('api:call', async (_event, method: string, params: unknown) => {
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
    if (!handler) throw new Error(`허용되지 않은 메서드: ${method}`)
    try {
      return await handler(params)
    } catch (e) {
      // IPC는 Error의 추가 필드를 버리므로, 화면이 고를 수 있게 코드를 메시지 앞에 붙인다.
      log.write(`${method} 실패: ${e instanceof EngineError ? `[${e.code}] ` : ''}${(e as Error).message}`)
      if (e instanceof EngineError) throw new Error(`[${e.code}] ${e.message}`)
      throw e
    }
  })
  log.prune()
  log.write(`앱 시작 ${app.getVersion()} · ${process.platform} ${process.arch}${app.isPackaged ? '' : ' · 개발 실행'}`)
  const settings = await loadSettings(dataDir)
  nativeTheme.themeSource = settings.theme
  await setup.init(settings.sttModel)
  runner.kick() // 앱이 꺼져 멈췄던 작업을 이어서 한다
  // 설치본에는 기본 메뉴 줄(File·Edit·View…)을 두지 않는다. 개발 실행에서는 새로 고침·개발자 도구 단축키 때문에 남긴다.
  if (app.isPackaged) Menu.setApplicationMenu(null)
  createWindow(settings.wizardDone ? HOME_CONTENT : WIZARD_CONTENT)
})

app.on('window-all-closed', () => {
  app.quit()
})
