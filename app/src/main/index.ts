import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeTheme, screen, session, shell } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, statfs } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'path'
import { probe as probeAudio } from '../core/audio.ts'
import { PRODUCT_NAME } from '../core/brand.ts'
import { EngineError } from '../core/errors.ts'
import { dirSize, readJson } from '../core/files.ts'
import { defaultThreads, detect } from '../core/hardware.ts'
import { editNote, parseNoteProps } from '../core/noteedit.ts'
import { attachNotes, AUDIO_EXTS, NOTE_EXTS, pairInputs } from '../core/inputs.ts'
import { DEFAULT_BEAM_SIZE, DEFAULT_MODEL, jobsDir, listJobs, STT_MODEL_CHOICES, VAD_MODEL } from '../core/job.ts'
import type { LlmSettings } from '../core/job.ts'
import { MODELS } from '../core/models.ts'
import { defaultDataDir, findFfmpeg, findWhisperCli } from '../core/paths.ts'
import { estimateJobSeconds, estimateSttSeconds, polishRate, sttSpeed, summarySeconds, testSample } from '../core/probe.ts'
import type { ProbeResult } from '../core/probe.ts'
import { DEFAULT_STEP_MODEL, estimateCredits90, estimateStepCredits90, POLISH_RECOMMENDED, RANKED, RECOMMENDED_COUNT } from '../core/llmcatalog.ts'
import type { ModelItem } from '../core/llmcatalog.ts'
import * as ollama from '../core/ollama.ts'
import { CHATKHU_BASE, CREDITS_PER_90MIN_SUMMARY, creditsPer90ByModel, listModels, OLLAMA_NAME, PRESETS, PROVIDERS, resolveSteps, usesCredits, verifyKey } from '../core/providers.ts'
import { chatkhuSttCredits } from '../core/stt/chatkhu.ts'
import type { ProviderId } from '../core/providers.ts'
import { listNotes, recentNotes } from '../core/recent.ts'
import { forgetProcessed, isRecording, listRecordings, markProcessed, recordingsDir, repairRecordings, unprocessedRecordings } from '../core/recordings.ts'
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
import { createRecorder } from './recorder.ts'
import { keyHint, readKey, removeKey, saveKey } from './secrets.ts'
import { createSetup } from './setup.ts'
import { createTray } from './tray.ts'
import { createWatcher } from './watcher.ts'

// 설치본은 extraResources로 넣은 resources/bin, 개발 중에는 저장소의 .cache/whisper/bin과 PATH의 ffmpeg.
const binDir = app.isPackaged ? join(process.resourcesPath, 'bin') : undefined
const whisperDirs = app.isPackaged
  ? [join(process.resourcesPath, 'bin', 'whisper')]
  : [join(app.getAppPath(), '..', '.cache', 'whisper', 'bin')]
const probeSample = app.isPackaged ? join(process.resourcesPath, 'probe-ko.wav') : join(app.getAppPath(), 'resources', 'probe-ko.wav')
// 창과 트레이의 아이콘 (scripts/icon.mjs가 만든다). 설치본의 실행 파일 아이콘은 electron-builder가 같은 파일로 넣는다
const iconPath = app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(app.getAppPath(), 'resources', 'icon.ico')
// LN_DATA_DIR: 개발 중 첫 실행 상태를 따로 시험할 때만 쓴다 (CLI의 --data-dir과 같은 역할)
const dataDir = process.env['LN_DATA_DIR'] || defaultDataDir()
const log = createLog(join(dataDir, 'logs'))
const RELEASES_URL = 'https://github.com/jeongho30/Note-crAIte/releases'

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
  busy: () => runner.transcribing() || holdStt(),
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
  llm: () => llmSteps(),
  apiKey: async () => {
    const { provider } = await loadSettings(dataDir)
    return provider ? readKey(dataDir, provider) : null
  },
  outDir,
  emit: (jobs) => {
    emit('jobs', jobs)
    onJobs(jobs)
    if (!runner.transcribing()) setup.resume() // 작업 때문에 미룬 속도 재기
  },
  onDone: (job) => watcher.onDone(job),
  holdStt: () => holdStt(),
  sttService: () => sttService(),
  chatkhuBase: CHATKHU_BASE
})

/** 지금 설정에서 요약과 전사문 다듬기가 부를 서비스·모델 (요약 서비스 또는 로컬 LLM, 안 하면 null) */
async function llmSteps(): Promise<{ summary: LlmSettings | null; polish: LlmSettings | null }> {
  const s = await loadSettings(dataDir)
  return resolveSteps(s, !!(s.provider && (await readKey(dataDir, s.provider))))
}

/** 새 작업의 받아쓰기 방식: 설정 > 고급 > 실험 기능에서 켜고 ChatKHU가 연결돼 있을 때만 ChatKHU 받아쓰기 */
async function sttService(): Promise<'whisper' | 'chatkhu'> {
  const { chatkhuStt, provider } = await loadSettings(dataDir)
  return chatkhuStt && provider === 'chatkhu' && (await readKey(dataDir, 'chatkhu')) ? 'chatkhu' : 'whisper'
}

// ── 앱에서 녹음하기 ──
// 녹음하는 동안에는 받아쓰기(와 속도 재기)를 멈춰 둔다. 설정 > 고급 > 녹음에서 켜면 함께 돈다.
let sttWhileRecording = false
const holdStt = (): boolean => recorder.active() && !sttWhileRecording

const recorder = createRecorder({
  dataDir,
  ffmpeg: () => findFfmpeg(binDir),
  log: log.write,
  onChange: (on) => {
    // 창이 숨어 있어도 화면의 녹음·소리 크기 계산이 늦춰지지 않게
    mainWindow?.webContents.setBackgroundThrottling(!on)
    if (!on) {
      runner.kick()
      setup.resume()
    }
    runner.refresh()
    updateTray()
  }
})

/** 앱에서 한 녹음 중 대기·실행 중인 작업이 아직 쓰는 것 (지우면 안 됨) */
async function recordingsInUse(): Promise<Set<string>> {
  const jobs = await listJobs(dataDir)
  const busy = jobs.filter((j) => j.status !== 'done' && j.stages.audio.status !== 'done')
  return new Set(busy.map((j) => j.input.audio.toLowerCase()))
}

/** 녹음을 휴지통으로 옮긴다 (되살릴 수 있게). 옮긴 수 */
async function trashRecordings(paths: string[]): Promise<number> {
  const inUse = await recordingsInUse()
  const targets = paths.filter((p) => isRecording(dataDir, p) && !inUse.has(p.toLowerCase()))
  const done: string[] = []
  for (const p of targets) {
    try {
      await shell.trashItem(p)
      done.push(p)
    } catch {
      // 못 옮긴 것은 그대로 둔다 (다른 프로그램이 열고 있음 등)
    }
  }
  await forgetProcessed(dataDir, done)
  if (done.length) log.write(`앱 녹음 ${done.length}개 휴지통으로`)
  return done.length
}

// 자동 처리(폴더 감시). 켜져 있으면 창을 닫아도 트레이에 남아 감시한다
const watcher = createWatcher({
  dataDir,
  start: (inputs) => runner.start(inputs),
  log: log.write,
  emit: (s) => {
    emit('watch', { ...s, login: loginState() })
    updateTray()
  }
})

// PC를 켜면 자동 실행: 이 인자로 켜지면 창 없이 트레이로만 시작한다
const HIDDEN_ARG = '--hidden'

/** 로그인할 때 자동 실행. 개발 실행(electron.exe)을 등록하면 앱이 아니라 빈 Electron이 켜지므로 설치본에서만 */
function loginState(): { supported: boolean; openAtLogin: boolean } {
  if (!app.isPackaged) return { supported: false, openAtLogin: false }
  return { supported: true, openAtLogin: app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin }
}

function setOpenAtLogin(on: boolean): void {
  if (!app.isPackaged) throw new EngineError('input', 'PC를 켜면 자동으로 실행하기는 설치한 앱에서만 쓸 수 있어요.')
  app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN_ARG] })
  log.write(`PC를 켜면 자동 실행: ${on ? '켬' : '끔'}`)
}

// ── 창 닫기와 트레이 ──
// 작업(대기 포함)이 있을 때 창을 닫으면 트레이로 숨어 계속하고, 없으면 앱을 끝낸다(9/28 결정).
let quitting = false
let closeHintShown = false
let lastJobs: JobView[] = []
let seenStatus = new Map<string, JobView['status']>()

const tray = createTray(iconPath, {
  open: showWindow,
  quit: () => void quitFromTray(),
  toggleWatch: () => void watcher.pause(!watcher.get().paused)
})

function showWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  updateTray()
}

/** 작업 중이거나, 창이 숨어 있거나, 자동 처리가 켜져 있으면 트레이를 두고, 아니면 없앤다. */
function updateTray(): void {
  const active = lastJobs.filter((j) => j.status === 'running' || j.status === 'queued')
  const hidden = !!mainWindow && !mainWindow.isVisible()
  const w = watcher.get()
  const recording = recorder.active()
  if (!active.length && !hidden && !w.enabled && !recording) return tray.destroy()
  tray.ensure()
  const run = active.find((j) => j.status === 'running' && j.stage)
  const waiting = active.length - (run ? 1 : 0)
  const watchLine = !w.enabled ? null : w.paused ? '자동 처리 멈춤' : w.error ? '자동 처리: 확인이 필요해요' : '폴더 감시 중'
  tray.update({
    lines: [
      recording ? '녹음 중' : null,
      run ? `${run.name} · ${run.stage === 'stt' ? `받아쓰기 ${Math.floor(run.frac * 100)}%` : '처리 중'}` : null,
      waiting ? `대기 ${waiting}개` : null,
      watchLine
    ].filter((x): x is string => !!x),
    watch: !w.enabled ? 'off' : w.paused ? 'paused' : 'on'
  })
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
    // 다듬기가 오류 없이 원문으로 돌아간 조각이 있으면 남긴다 (모델이 문단 수나 길이를 못 맞춘 것)
    const polish = j.status === 'done' && j.polish?.fallbackChunks ? ` · 다듬기 ${j.polish.chunks}조각 중 ${j.polish.fallbackChunks}조각은 원문 그대로${j.polish.reasons ? ` (${j.polish.reasons.join(", ")})` : ""}` : ''
    log.write(`작업 ${STATUS_WORD[j.status]}: ${j.name}${why}${polish}`)
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
  if (recorder.active()) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: PRODUCT_NAME,
      message: '녹음 중이에요',
      detail: '끝내면 녹음을 여기까지 저장해요. 다음에 앱을 켜면 홈에서 노트로 만들 수 있어요.',
      buttons: ['계속 녹음하기', '끝내기'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (response !== 1) return
  } else if (runner.activeCount() > 0) {
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
    /** 이 PC에서 받아쓰기 예상 시간(초). 속도를 아직 안 쟀거나 ChatKHU로 받아쓰면 null */
    sttS: number | null
    /** 요약 예상 크레딧 (ChatKHU일 때만) */
    credits: number | null
    /** ChatKHU 받아쓰기 예상 크레딧 (ChatKHU로 받아쓸 때만) */
    sttCredits: number | null
    /** 오디오 준비부터 노트 저장까지 예상 시간(초). 속도를 아직 안 쟀거나 ChatKHU로 받아쓰면 null */
    totalS: number | null
  }[]
  rejected: { name: string; reason: string }[]
  /** 이 녹음들을 받아쓸 방식 (지금 설정) */
  stt: 'whisper' | 'chatkhu'
}

/**
 * 90분 강의 한 개의 크레딧: 요약 + 전사문 다듬기(켠 경우). 로컬 LLM이나 크레딧을 쓰지 않는 서비스로 하는 단계는 들지 않고, 크레딧이 드는 단계가 없으면 null.
 * polish: false면 다듬기를 빼고 센다 ([요약 다시 만들기]는 다시 다듬지 않는다)
 */
async function jobCredits90({ polish = true } = {}): Promise<number | null> {
  const steps = await llmSteps()
  const billed = (s: LlmSettings | null): s is LlmSettings => !!s && !s.ollama && usesCredits(s.service)
  // 요약: 써 본 기록, 없으면 단가표 어림, 그것도 없으면 기본값
  const summary = billed(steps.summary)
    ? (creditsPer90ByModel(await listJobs(dataDir))[steps.summary.model] ?? estimateCredits90(steps.summary.model) ?? CREDITS_PER_90MIN_SUMMARY)
    : null
  const polishCredits = polish && billed(steps.polish) ? (estimateStepCredits90('polish', steps.polish.model) ?? 0) : null
  return summary === null && polishCredits === null ? null : (summary ?? 0) + (polishCredits ?? 0)
}

/** 남은 크레딧으로 90분 강의를 몇 개 더 요약할 수 있는지. 요약을 요약 서비스로 하지 않으면 null */
async function summariesLeft(credits: number | null): Promise<number | null> {
  const { summary } = await llmSteps()
  const per90 = await jobCredits90()
  if (credits == null || !summary || summary.ollama || !usesCredits(summary.service) || !per90) return null
  return Math.floor(credits / per90)
}

/** 시작 전 확인에 보여 줄 것: 녹음마다 길이·녹음 시각·예상 시간·예상 크레딧, 넣을 수 없는 파일과 이유. */
async function prepare(paths: string[]): Promise<Prepared> {
  const { recordings, ignored } = pairInputs(paths)
  const rejected = ignored.map((p) => ({
    name: basename(p),
    reason: NOTE_EXTS.some((e) => p.toLowerCase().endsWith('.' + e)) ? '같은 이름의 녹음이 없는 필기예요' : '녹음 파일이 아니에요'
  }))
  const [probe, settings, per90, stt, steps] = await Promise.all([loadProbe(), loadSettings(dataDir), jobCredits90(), sttService(), llmSteps()])
  const cloud = stt === 'chatkhu'
  // 이 PC에서 끝낸 작업이 있으면 그 실제 속도로 예상한다
  const history = await listJobs(dataDir)
  const speed = probe && !cloud ? sttSpeed(probe, history, settings.sttArgs ? parseArgs(settings.sttArgs) : null) : null
  const polish = polishRate(history, steps.polish)
  const summaryS = summarySeconds(history, steps.summary)
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
        sttS: speed && info.durationS ? Math.round(estimateSttSeconds(info.durationS, speed)) : null,
        totalS: speed && info.durationS ? Math.round(estimateJobSeconds(info.durationS, speed, summaryS, polish)) : null,
        credits: per90 !== null && info.durationS ? Math.max(1, Math.round((info.durationS / 5400) * per90)) : null,
        sttCredits: cloud && info.durationS ? chatkhuSttCredits(info.durationS) : null
      })
    } catch {
      rejected.push({ name: basename(r.audio), reason: '소리를 읽을 수 없는 파일이에요' })
    }
  }
  return { recordings: out, rejected, stt }
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
      credits: durationS && per90 !== null ? Math.max(1, Math.round((durationS / 5400) * per90)) : null
    }
  }
}

/**
 * 크레딧을 쓰지 않는 서비스(OpenAI·Claude·Gemini)의 모델 선택지: 추천 순서가 없어 서비스의 글 모델 목록을 그대로 보인다.
 * 기본 모델만 "추천"으로 선택 칸에 바로 보이고 나머지는 [전체 모델 보기]에 있다.
 */
function plainModels(provider: ProviderId, items: ModelItem[], failed: boolean, selected: string, recommended: string) {
  const ids = [...new Set([...(items.some((m) => m.id === recommended) || !items.length ? [recommended] : []), ...items.map((m) => m.id), selected])]
  return {
    service: PROVIDERS.find((x) => x.id === provider)!.name,
    credits: false,
    selected,
    recommended,
    failed,
    available: items.map((m) => m.id),
    models: ids.map((id, i) => ({ id, owner: null, rank: i + 1, recommended: id === recommended, note: null, credits90: null, source: null }))
  }
}

function providerOf(id: unknown): ProviderId {
  const p = PROVIDERS.find((x) => x.id === id && x.available)
  if (!p) throw new EngineError('input', '아직 지원하지 않는 요약 서비스예요.')
  return p.id
}

/** 화면에 보일 단계별 서비스: 이름, 모델, 로컬인지 */
type StepView = { service: string; name: string; model: string; local: boolean }
function stepView(s: LlmSettings | null): StepView | null {
  if (!s) return null
  const name = s.ollama ? OLLAMA_NAME : (PROVIDERS.find((x) => x.id === s.service)?.name ?? s.service ?? '')
  return { service: s.service ?? '', name, model: s.model, local: !!s.ollama }
}

/** 연결된 요약 서비스(키·잔액)와, 요약·전사문 다듬기를 무엇으로 하는지. 화면은 요약을 할 수 있는지를 summary로 본다 */
async function llmStatus(): Promise<{
  provider: ProviderId | null; name?: string; keyHint?: string; credits?: number | null; summariesLeft?: number | null
  summary: StepView | null; polish: StepView | null
}> {
  const { provider } = await loadSettings(dataDir)
  const key = provider ? await readKey(dataDir, provider) : null
  const steps = await llmSteps()
  const views = { summary: stepView(steps.summary), polish: stepView(steps.polish) }
  if (!provider || !key) return { provider: null, ...views }
  // 잔액은 참고용이라 못 불러와도(오프라인) 연결 상태는 그대로 보인다.
  // 잔액을 볼 수 있는 서비스(ChatKHU)만 물어본다
  const credits = usesCredits(provider) ? await verifyKey(provider, key).then((r) => r.credits, () => null) : null
  return {
    provider,
    name: PROVIDERS.find((x) => x.id === provider)?.name,
    keyHint: keyHint(key),
    credits,
    summariesLeft: await summariesLeft(credits),
    ...views
  }
}

/** 로컬 LLM 블록: Ollama가 켜져 있는지, 설치된 모델, 단계별로 고른 모델과 요청 옵션 */
async function ollamaState() {
  const local = (await loadSettings(dataDir)).ollama
  let running = true
  let version: string | null = null
  let models: ollama.OllamaModel[] = []
  try {
    version = await ollama.version()
    models = await ollama.listModels()
  } catch {
    running = false
  }
  const step = (name: 'summary' | 'polish') => {
    const defaultRequest = ollama.requestText(ollama.DEFAULT_REQUEST[name])
    return { model: local[`${name}Model`], request: local[`${name}Request`] ?? defaultRequest, defaultRequest }
  }
  return {
    running,
    version,
    endpoint: `${ollama.OLLAMA_BASE}/api/chat`,
    models,
    summary: step('summary'),
    polish: step('polish'),
    // num_ctx "auto"가 90분 강의(약 27,000자)에서 잡는 값
    autoCtx90: ollama.autoNumCtx(27_000 + 3000, 8192)
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

  // hasKey: 전에 넣은 키가 남아 있어 키를 다시 붙이지 않고 연결할 수 있다
  'llm.providers': async () => Promise.all(PROVIDERS.map(async ({ id, name, available }) => ({ id, name, available, hasKey: !!(await readKey(dataDir, id)) }))),
  'llm.status': () => llmStatus(),
  // 키를 확인하고, 맞으면 암호화해 저장한 뒤 이 서비스를 연결한다.
  'llm.connect': async (p) => {
    const { provider, key } = p as { provider: unknown; key: unknown }
    const id = providerOf(provider)
    // 키를 비워 보내면 이 서비스에 저장해 둔 키로 다시 연결한다 (서비스를 바꿔 쓸 때)
    const apiKey = String(key ?? '').trim() || (await readKey(dataDir, id)) || ''
    if (!apiKey) throw new EngineError('auth', '키를 붙여 넣어 주세요.')
    const { credits } = await verifyKey(id, apiKey)
    await saveKey(dataDir, id, apiKey)
    const before = await loadSettings(dataDir)
    if (before.provider === id) await updateSettings(dataDir, { provider: id })
    else {
      // 서비스가 바뀌면 고른 모델 이름이 맞지 않는다: 요약은 새 서비스의 기본 모델로, 다듬기는 끈다.
      // 기본 모델이 목록에 없으면(이름이 바뀜) 목록의 첫 모델을 쓴다
      const items = usesCredits(id) ? [] : await listModels(id, apiKey).catch(() => [])
      const fallback = items.length && !items.some((m) => m.id === PRESETS[id].model) ? items[0].id : null
      await updateSettings(dataDir, { provider: id, summaryModel: fallback, polishModel: null })
      log.write(`요약 서비스: ${id}${fallback ? ` · 요약 모델 ${fallback}` : ''}`)
    }
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
  // 시작 전 확인에서 녹음 하나에 붙일 필기를 고른다
  'inputs.pickNotes': async () => {
    const win = BrowserWindow.getFocusedWindow()
    const opts = { properties: ['openFile'] as 'openFile'[], filters: [{ name: '필기', extensions: NOTE_EXTS }] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || !r.filePaths[0] ? null : { path: r.filePaths[0], name: basename(r.filePaths[0]) }
  },
  'inputs.prepare': (p) => prepare((p as unknown[]).map(String)),
  // 시작 전 확인에서 파일을 더 넣을 때: 이미 목록에 있는 녹음의 필기는 그 녹음에 붙이고, 나머지만 새로 확인한다
  'inputs.attach': (p) => {
    const { existing, picked } = p as { existing: unknown[]; picked: unknown[] }
    const { attached, rest } = attachNotes(existing.map(String), picked.map(String))
    return { attached: attached.map((a) => ({ ...a, notesName: basename(a.notes) })), rest }
  },
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
    // 시작할 때 고른 언어는 그 과목의 강의 언어로 저장한다 (다음에 그 과목을 고르면 먼저 골라져 있게)
    const { subjectLanguage } = await loadSettings(dataDir)
    const next: Record<string, Language> = { ...subjectLanguage }
    for (const i of items) if (i.subject) next[i.subject] = i.language
    await updateSettings(dataDir, { lastSubject: items[0].subject, subjectLanguage: next })
    await runner.start(items)
    await markProcessed(dataDir, items.map((i) => i.audio))
  },
  'jobs.retry': (p) => runner.retry(String(p)),
  'jobs.transcriptOnly': (p) => runner.transcriptOnly(String(p)),
  // ChatKHU 받아쓰기에서 멈춘 작업을 이 PC에서 받아쓰기
  'jobs.localStt': (p) => runner.localStt(String(p)),
  'jobs.cancel': (p) => runner.cancel(String(p)),
  'jobs.remove': (p) => runner.remove(String(p)),
  // 끝난 작업의 노트를 폴더에서 보기 (경로는 화면이 아니라 job.json에서 가져온다)
  'jobs.revealNote': async (p) => {
    const path = await runner.notePath(String(p))
    if (!path) throw new EngineError('input', '노트를 찾지 못했어요.')
    shell.showItemInFolder(path)
  },

  // ── 설정 화면 ──
  // 화면 색: Electron이 prefers-color-scheme를 바꾸고, 창 버튼의 기호 색은 nativeTheme의 updated에서 맞춘다
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
    const recommended = PRESETS[provider ?? 'chatkhu'].model
    const selected = summaryModel ?? recommended
    const key = provider ? await readKey(dataDir, provider) : null
    let items: ModelItem[] = []
    let failed = false
    if (provider && key) items = await listModels(provider, key).catch(() => ((failed = true), []))
    if (provider && !usesCredits(provider)) return plainModels(provider, items, failed, selected, recommended)
    const measured = creditsPer90ByModel(await listJobs(dataDir))
    const owners = new Map(items.map((m) => [m.id, m.owner]))
    const available = new Set(items.map((m) => m.id))
    // 목록을 불러왔으면 목록에 없는 모델은 뺀다 (서비스에서 내려간 모델)
    const ranked = RANKED.filter((r) => failed || !items.length || available.has(r.id))
    const ids = [...new Set([...ranked.map((r) => r.id), selected])]
    return {
      service: PROVIDERS.find((x) => x.id === (provider ?? 'chatkhu'))!.name,
      credits: true,
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
    const { provider } = await loadSettings(dataDir)
    await updateSettings(dataDir, { summaryModel: model === PRESETS[provider ?? 'chatkhu'].model ? null : model })
    log.write(`요약 모델: ${model}`)
  },
  // 설정 > 고급 > 요약 세부설정: 전사문 다듬기 모델. llm.models와 같은 형식으로, 다듬기 추천 모델을 앞에 두고 나머지는 요약 추천 순서
  'llm.steps': async () => {
    const { provider, polishModel, ollama: local } = await loadSettings(dataDir)
    const key = provider ? await readKey(dataDir, provider) : null
    let items: ModelItem[] = []
    let failed = false
    if (provider && key) items = await listModels(provider, key).catch(() => ((failed = true), []))
    const localSteps = { summary: local.summary, polish: local.polish, summaryModel: local.summaryModel, polishModel: local.polishModel }
    if (provider && !usesCredits(provider)) {
      const { selected: _s, recommended, ...rest } = plainModels(provider, items, failed, polishModel ?? PRESETS[provider].model, PRESETS[provider].model)
      return { polishModel, local: localSteps, defaultModel: recommended, ...rest }
    }
    const owners = new Map(items.map((m) => [m.id, m.owner]))
    const available = new Set(items.map((m) => m.id))
    const order = [...new Set([...POLISH_RECOMMENDED, ...RANKED.map((r) => r.id)])].filter((id) => failed || !items.length || available.has(id))
    const ids = [...new Set([...order, ...(polishModel ? [polishModel] : [])])]
    return {
      polishModel,
      // 단계를 로컬 LLM으로 하는지와, 로컬에서 고른 모델 (없으면 로컬을 고를 수 없다)
      local: localSteps,
      service: PROVIDERS.find((x) => x.id === (provider ?? 'chatkhu'))!.name,
      credits: true,
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
    const { polishModel, summaryLocal, polishLocal } = (p ?? {}) as { polishModel?: unknown; summaryLocal?: unknown; polishLocal?: unknown }
    const patch: Partial<Settings> = {}
    // 단계를 로컬 LLM으로 돌리기: 로컬 모델을 골라 둔 단계만 켤 수 있다
    if (summaryLocal !== undefined || polishLocal !== undefined) {
      const local = { ...(await loadSettings(dataDir)).ollama }
      if (summaryLocal !== undefined) local.summary = summaryLocal === true
      if (polishLocal !== undefined) local.polish = polishLocal === true
      if ((local.summary && !local.summaryModel) || (local.polish && !local.polishModel)) {
        throw new EngineError('input', '아래 로컬 LLM (Ollama)에서 모델을 먼저 골라 주세요.')
      }
      patch.ollama = local
    }
    if (polishModel !== undefined) {
      if (polishModel !== null && (typeof polishModel !== 'string' || !polishModel.trim())) throw new EngineError('input', '다듬기 모델을 골라 주세요.')
      patch.polishModel = polishModel === null ? null : polishModel.trim()
    }
    await updateSettings(dataDir, patch)
    log.write(`요약 세부설정: ${JSON.stringify(patch)}`)
  },

  // ── 설정 > 고급 > 로컬 LLM (Ollama) ──
  'ollama.get': () => ollamaState(),
  // 모델과 요청 옵션을 저장한다. 기본 옵션과 같으면 기본으로 둔다
  'ollama.save': async (p) => {
    const o = (p ?? {}) as Record<string, unknown>
    const local = { ...(await loadSettings(dataDir)).ollama }
    for (const step of ['summary', 'polish'] as const) {
      const model = o[`${step}Model`]
      if (typeof model === 'string' && model.trim()) local[`${step}Model`] = model.trim()
      const request = o[`${step}Request`]
      if (typeof request === 'string') {
        const text = ollama.requestText(ollama.parseRequest(request))
        local[`${step}Request`] = text === ollama.requestText(ollama.DEFAULT_REQUEST[step]) ? null : text
      }
    }
    await updateSettings(dataDir, { ollama: local })
    log.write(`로컬 LLM 설정: ${JSON.stringify(local)}`)
    return ollamaState()
  },
  // 고친 옵션으로 짧게 한 번 불러 본다 (저장하지 않음)
  'ollama.test': async (p) => {
    const { step, model, request } = (p ?? {}) as { step?: unknown; model?: unknown; request?: unknown }
    if (typeof model !== 'string' || !model) throw new EngineError('input', '모델을 골라 주세요.')
    const req = ollama.parseRequest(String(request ?? ''))
    const [text, usage] = await ollama.chat(`${ollama.OLLAMA_BASE}/api/chat`, model, [{ role: 'user', content: '컴파일러가 무엇인지 한 문장으로 설명해 줘.' }], {
      request: req, maxTokens: 128, firstMs: 5 * 60_000, idleMs: 60_000
    })
    const n = (k: string): number => (typeof usage[k] === 'number' ? (usage[k] as number) : 0)
    const result = {
      chars: text.length,
      loadS: n('load_duration') / 1e9,
      tokensPerS: n('eval_duration') ? n('completion_tokens') / (n('eval_duration') / 1e9) : null,
      numCtx: n('num_ctx') || null
    }
    log.write(`로컬 LLM 시험(${step === 'summary' ? '요약' : '다듬기'}): ${model} · ${ollama.requestText(req)} · 올리기 ${result.loadS.toFixed(1)}초 · ${result.tokensPerS?.toFixed(1) ?? '?'}토큰/초`)
    return result
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
    const recordings = await listRecordings(dataDir)
    const downloaded = []
    for (const id of Object.keys(MODELS.whisper)) if (await haveModel(id)) downloaded.push(id)
    return {
      modelsBytes: await dirSize(join(dataDir, 'models')),
      models: downloaded,
      jobsBytes: await dirSize(jobsDir(dataDir)),
      done: jobs.filter((j) => j.status === 'done').length,
      stopped: jobs.filter((j) => j.status === 'failed' || j.status === 'cancelled').length,
      recordings: recordings.length,
      recordingsBytes: recordings.reduce((n, r) => n + r.bytes, 0)
    }
  },
  'jobs.clearDone': async () => {
    const n = await runner.clearDone()
    log.write(`완료한 작업 기록 ${n}개 지움`)
    return n
  },

  // ── 앱에서 녹음하기 ──
  // 녹음을 시작하면 도는 받아쓰기를 멈추고 대기로 되돌린다 (설정에서 함께 돌게 켜지 않았으면)
  'rec.begin': async (p) => {
    const source = p === 'system' ? 'system' : 'mic'
    if (source === 'system' && process.platform !== 'win32') throw new EngineError('input', '컴퓨터 소리 녹음은 Windows에서만 돼요.')
    await recorder.begin(source)
    if (!sttWhileRecording) runner.holdNow()
  },
  'rec.chunk': (p) => recorder.chunk(p),
  'rec.end': () => recorder.end(),
  // 아직 노트로 만들지 않은 앱 녹음 (홈 배너)
  'rec.unprocessed': async () => (await unprocessedRecordings(dataDir)).map(({ path, name, bytes }) => ({ path, name, bytes })),
  'rec.trash': (p) => trashRecordings((p as unknown[]).map(String)),
  // 설정 > 저장 공간: 앱 녹음을 모두 휴지통으로 (아직 처리 중인 녹음은 뺀다)
  'rec.clear': async () => trashRecordings((await listRecordings(dataDir)).map((r) => r.path)),
  'rec.openFolder': () => openFolder(recordingsDir(dataDir)),
  'rec.openMicSettings': () => {
    if (process.platform === 'win32') void shell.openExternal('ms-settings:privacy-microphone')
  },
  // 설정 > 고급 > 실험 기능: ChatKHU 받아쓰기. 켜는 것은 ChatKHU가 연결돼 있을 때만
  'settings.setChatkhuStt': async (p) => {
    const on = p === true
    if (on) {
      const { provider } = await loadSettings(dataDir)
      if (provider !== 'chatkhu' || !(await readKey(dataDir, 'chatkhu'))) throw new EngineError('auth', 'ChatKHU를 먼저 연결해 주세요.')
    }
    await updateSettings(dataDir, { chatkhuStt: on })
    log.write(`ChatKHU 받아쓰기: ${on ? '켬' : '끔'}`)
    return on
  },
  'settings.setSttWhileRecording': async (p) => {
    sttWhileRecording = p === true
    await updateSettings(dataDir, { sttWhileRecording })
    log.write(`녹음 중 받아쓰기: ${sttWhileRecording ? '켬' : '끔'}`)
    runner.kick()
    runner.refresh()
    return sttWhileRecording
  },

  'app.openData': () => openFolder(dataDir),
  'app.openLogs': () => openFolder(log.dir),
  'app.openNotices': () => openNotices(),
  'app.openReleases': () => void shell.openExternal(RELEASES_URL),

  // ── 자동 처리(폴더 감시) ──
  'watch.get': () => ({ ...watcher.get(), login: loginState() }),
  // 켜기 전 확인: 폴더에 있는 녹음 수, 감시 폴더에 없는 과목, 저장 폴더와 겹치는지
  'watch.inspect': (p) => {
    const folder = String(p ?? '')
    if (!isAbsolute(folder)) throw new EngineError('input', '감시할 폴더를 골라 주세요.')
    return watcher.inspect(folder)
  },
  'watch.enable': async (p) => {
    const o = p as { folder: unknown; createSubjects: unknown; processExisting: unknown; openAtLogin: unknown }
    const folder = String(o.folder ?? '')
    if (!isAbsolute(folder)) throw new EngineError('input', '감시할 폴더를 골라 주세요.')
    await outDir() // 저장 폴더가 있어야 노트를 만든다
    const subjects = Array.isArray(o.createSubjects) ? o.createSubjects.map(String).filter((s) => s && !/[\\/]/.test(s)) : []
    await watcher.enable(folder, { createSubjects: subjects, processExisting: o.processExisting === true })
    if (o.openAtLogin === true && app.isPackaged) setOpenAtLogin(true)
    return { ...watcher.get(), login: loginState() }
  },
  // 끄면 자동 실행도 끈다 (자동 처리가 없으면 PC를 켤 때 앱을 띄울 이유가 없다)
  'watch.disable': async () => {
    await watcher.disable()
    if (loginState().openAtLogin) setOpenAtLogin(false)
    return { ...watcher.get(), login: loginState() }
  },
  'watch.pause': async (p) => {
    await watcher.pause(p === true)
    return { ...watcher.get(), login: loginState() }
  },
  'watch.setOpenAtLogin': (p) => {
    setOpenAtLogin(p === true)
    return { ...watcher.get(), login: loginState() }
  },
  'watch.openFolder': async () => {
    const { folder } = (await loadSettings(dataDir)).watch
    if (!folder) throw new EngineError('input', '감시 폴더가 정해지지 않았어요.')
    await openFolder(folder)
  },

  'notes.recent': async () => recentNotes(await outDir()),
  'notes.list': async () => listNotes(await outDir()),
  'notes.open': (p) => openNote(String(p)),
  'notes.read': (p) => readNote(String(p)),
  // 노트 목록·미리보기의 [정보 수정]: 이 앱이 만든 노트만 고친다 (머리말·파일 이름·폴더를 함께 바꾼다)
  'notes.editInfo': async (p) => {
    const checked = await checkNotePath(String(p))
    const text = await readFile(checked, 'utf8').catch(() => {
      throw new EngineError('input', '노트 파일을 찾지 못했어요. 옮기거나 지웠을 수 있어요.')
    })
    const props = parseNoteProps(text)
    return props ? { editable: true, ...props } : { editable: false }
  },
  'notes.edit': async (p) => {
    const { path, title, subject, date } = p as { path: unknown; title: unknown; subject: unknown; date: unknown }
    const checked = await checkNotePath(String(path))
    if (await runner.noteBusy(checked)) throw new EngineError('input', '요약을 만드는 중이라 끝난 뒤에 수정할 수 있어요.')
    const r = await editNote(await outDir(), checked, { title: String(title ?? ''), subject: subject ? String(subject) : null, date: String(date ?? '') })
    await runner.noteEdited(checked, r.path, r.props)
    return r.path
  },
  // 노트 삭제: 파일은 휴지통으로 옮긴다 (되살릴 수 있게). 이 노트를 만든 작업은 노트 경로만 비운다
  'notes.delete': async (p) => {
    const checked = await checkNotePath(String(p))
    if (await runner.noteBusy(checked)) throw new EngineError('input', '요약을 만드는 중이라 끝난 뒤에 삭제할 수 있어요.')
    try {
      await shell.trashItem(checked)
    } catch (e) {
      throw new EngineError('input', '휴지통으로 옮기지 못했어요: ' + (e instanceof Error ? e.message : String(e)))
    }
    await runner.noteDeleted(checked)
    log.write('노트 삭제(휴지통)')
  },
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

// 창의 화면 영역(창 틀·메뉴 줄·맨 위 띠 제외)은 4:3. 마법사는 최소 크기로 열고, 끝나면 홈 크기로 키운다.
const ASPECT = 4 / 3
const MIN_CONTENT: Size = { width: 800, height: 600 }
const WIZARD_CONTENT: Size = MIN_CONTENT
const HOME_CONTENT: Size = { width: 1000, height: 750 }
// 기본 제목 줄을 숨기고 화면이 맨 위에 직접 그리는 띠의 높이 (tokens.css의 --titlebar-h와 같아야 한다). 크기 계산에서는 창 틀로 친다
const TITLE_BAR = 32

/** Windows가 띠 위에 겹쳐 그리는 최소화·닫기 버튼. 배경은 비워 띠 색이 보이게 하고 기호 색만 화면 색에 맞춘다 */
function titleBarOverlay(): { color: string; symbolColor: string; height: number } {
  return { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#bdb9b3' : '#46514f', height: TITLE_BAR }
}

let mainWindow: BrowserWindow | null = null

/** 화면 영역을 target으로 바꾸되, 창 틀까지 모니터 작업 영역에 들어가게 줄이고 가운데에 둔다. */
function resizeContent(win: BrowserWindow, target: Size): void {
  const outer = win.getBounds()
  const inner = win.getContentBounds()
  const frame = { width: outer.width - inner.width, height: outer.height - inner.height + TITLE_BAR }
  const size = fitContent(target, screen.getDisplayMatching(outer).workArea, frame, ASPECT, MIN_CONTENT)
  win.setContentSize(size.width, size.height + TITLE_BAR)
  win.center()
}

// 창 크기를 바꿀 때 화면 영역(창 틀·메뉴 줄 제외)을 4:3으로 맞춘다.
// Windows의 setAspectRatio는 창 틀까지 포함한 크기에 비율을 맞춰서 화면 영역 비율이 틀어진다.
function keepContentAspect(win: BrowserWindow): void {
  win.on('will-resize', (event, next, { edge }) => {
    const outer = win.getBounds()
    const inner = win.getContentBounds()
    const frameW = outer.width - inner.width
    const frameH = outer.height - inner.height + TITLE_BAR
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

function createWindow(target: Size, show = true): void {
  const win = new BrowserWindow({
    show,
    icon: iconPath,
    width: target.width,
    height: target.height,
    minWidth: MIN_CONTENT.width,
    minHeight: MIN_CONTENT.height + TITLE_BAR,
    useContentSize: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })
  keepContentAspect(win)
  const syncOverlay = (): void => win.setTitleBarOverlay(titleBarOverlay())
  nativeTheme.on('updated', syncOverlay)
  win.on('closed', () => nativeTheme.off('updated', syncOverlay))
  resizeContent(win, target)
  mainWindow = win
  win.on('closed', () => (mainWindow = null))
  win.on('close', (event) => {
    if (quitting || (runner.activeCount() === 0 && !watcher.enabled() && !recorder.active())) return
    event.preventDefault()
    win.hide()
    updateTray()
    if (!closeHintShown) {
      closeHintShown = true
      if (recorder.active()) {
        tray.notify('창을 닫아도 녹음은 계속돼요', '끝내려면 작업 표시줄 오른쪽 아이콘으로 창을 다시 열어 주세요.')
      } else if (runner.activeCount() > 0) {
        tray.notify('창을 닫아도 계속해요', '받아쓰기가 끝나면 알려 드려요. 작업 표시줄 오른쪽 아이콘으로 다시 열 수 있어요.')
      } else {
        tray.notify('창을 닫아도 폴더를 계속 살펴요', '녹음이 들어오면 노트를 만들고 알려 드려요. 작업 표시줄 오른쪽 아이콘으로 다시 열 수 있어요.')
      }
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
  if (stopped || (!runner.busy() && !recorder.active())) return
  event.preventDefault()
  void Promise.all([runner.shutdown(), recorder.close()]).finally(() => {
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
  sttWhileRecording = settings.sttWhileRecording
  // 앱이 꺼져 녹음 중 파일로 남은 앱 녹음을 녹음 파일로 만든다 (홈의 "처리하지 않은 녹음"에 뜬다)
  await repairRecordings(findFfmpeg(binDir), dataDir, null).catch((e) => log.write(`남은 녹음 고치기 실패: ${(e as Error).message}`))
  // 컴퓨터 소리 녹음: 화면의 getDisplayMedia에 화면 하나와 시스템 소리(loopback)를 준다. 영상은 화면 쪽에서 바로 끈다
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then(
      (sources) => callback(sources[0] && process.platform === 'win32' ? { video: sources[0], audio: 'loopback' } : {}),
      () => callback({})
    )
  })
  await setup.init(settings.sttModel)
  runner.kick() // 앱이 꺼져 멈췄던 작업을 이어서 한다
  await watcher.init()
  // 설치본에는 기본 메뉴 줄(File·Edit·View…)을 두지 않는다. 개발 실행에서는 새로 고침·개발자 도구 단축키 때문에 남긴다.
  if (app.isPackaged) Menu.setApplicationMenu(null)
  // PC를 켜면서 자동 실행된 경우: 자동 처리가 켜져 있으면 창 없이 트레이로만 시작한다
  const startHidden = process.argv.includes(HIDDEN_ARG) && settings.wizardDone && settings.watch.enabled
  createWindow(settings.wizardDone ? HOME_CONTENT : WIZARD_CONTENT, !startHidden)
  if (startHidden) updateTray()
})

app.on('window-all-closed', () => {
  app.quit()
})
