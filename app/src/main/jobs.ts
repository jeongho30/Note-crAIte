// 작업 실행기: 시작 전 확인에서 넣은 녹음을 작업으로 만들고, 한 번에 하나씩 돌린다.
// 진행 상황은 바뀔 때마다 화면에 'jobs' 이벤트로 보낸다. 앱을 껐다 켜면 끝나지 않은 작업을 이어서 한다.
import { powerSaveBlocker } from 'electron'
import { readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { EngineError } from '../core/errors.ts'
import { writeJsonAtomic } from '../core/files.ts'
import { createJob, DEFAULT_BEAM_SIZE, jobsDir, listJobs, loadJob, runJob, STAGES } from '../core/job.ts'
import type { Job, JobContext, LlmSettings, StageName, StageState } from '../core/job.ts'
import { MODELS } from '../core/models.ts'
import { estimateSttSeconds } from '../core/probe.ts'
import type { ProbeResult } from '../core/probe.ts'
import type { Language } from '../core/settings.ts'

export type JobInput = { audio: string; notes: string | null; subject: string | null; language: Language; from?: 'watch' }

export type StageView = { name: StageName; status: StageState['status']; ms: number | null }

export type JobView = {
  id: string
  name: string
  subject: string | null
  status: Job['status']
  /** 지금 도는 단계와 그 단계의 진행률 (running일 때만) */
  stage: StageName | null
  frac: number
  /** 받아쓰기가 끝날 때까지 남은 시간(초). 모르면 null */
  etaS: number | null
  durationS: number | null
  /** queued일 때 무엇을 기다리는지 */
  waiting: 'model' | 'turn' | null
  error: Job['error'] | null
  notePath: string | null
  // ── 작업 목록에서 펼쳐 보는 것 ──
  createdAt: string
  recordedAt: string | null
  language: string
  audioPath: string
  hasNotes: boolean
  stages: StageView[]
  /** 요약에 쓴 크레딧 (잔액 차이로 잰 값) */
  credits: number | null
  /** 받아쓰기 조각 진행 (받아쓰기를 끝내지 못한 작업만) */
  sttChunks: { done: number; total: number } | null
  /** 요청이 몰려(429) 저절로 다시 시도할 시각 (ms). 없으면 null */
  autoRetryAt: number | null
}

type Deps = {
  dataDir: string
  ffmpeg: () => string
  whisperCli: () => string
  /** 모델을 받고 속도 재기가 끝날 때까지 기다린다 */
  whenSttReady: () => Promise<void>
  sttReady: () => boolean
  probe: () => Promise<ProbeResult | null>
  defaultThreads: () => Promise<number>
  /** 지금 설정의 받아쓰기 모델과 고친 옵션 (없으면 null = 앱 기본) */
  stt: () => Promise<{ model: string; args: string[] | null }>
  /** 작업을 만들 때의 요약 설정과, 실행할 때의 API 키 */
  llm: () => Promise<LlmSettings | null>
  /** 지금 설정의 전사문 다듬기 모델 (꺼져 있으면 null) */
  steps: () => Promise<{ polishModel: string | null }>
  apiKey: () => Promise<string | null>
  outDir: () => Promise<string>
  emit: (jobs: JobView[]) => void
  /** 작업이 끝났을 때 (자동 처리로 들어온 녹음을 "처리됨"으로 옮기는 데 쓴다) */
  onDone?: (job: Job) => Promise<void>
}

const EMIT_INTERVAL_MS = 500
const RATE_LIMIT_RETRY_MS = 60_000 // 요청 몰림(429)은 1분 뒤 한 번만 저절로 다시 시도한다 (9/28 결정)

export function createJobRunner(d: Deps) {
  let running = false
  let current: { id: string; stage: StageName; frac: number; stageStartedAt: number } | null = null
  let lastEmit = 0
  let probeCache: ProbeResult | null = null
  let last: JobView[] = [] // 마지막으로 보낸 목록 (트레이·창 닫기 판단용)
  let loopDone: Promise<void> = Promise.resolve()
  let controller: AbortController | null = null
  let stopping = false
  const autoRetryAt = new Map<string, number>() // 저절로 다시 시도할 작업 → 시각
  const autoRetried = new Set<string>() // 이미 한 번 저절로 다시 시도한 작업

  const dirOf = (id: string): string => join(jobsDir(d.dataDir), id)

  function sttChunks(job: Job): JobView['sttChunks'] {
    const total = job.audio?.chunks.length
    if (!total || job.stages.stt.status === 'done') return null
    try {
      return { done: readdirSync(join(dirOf(job.id), 'stt')).filter((f) => /^part_\d+\.json$/.test(f)).length, total }
    } catch {
      return { done: 0, total }
    }
  }

  function stageViews(job: Job): StageView[] {
    // 전사문 다듬기는 켠 작업만 보인다 (꺼져 있으면 모든 작업에 "건너뜀"이 붙어 번거롭다)
    const shown = STAGES.filter((name) => name !== 'polish' || (job.stages.polish && job.stages.polish.status !== 'skipped' && job.settings.polishModel))
    return shown.map((name) => {
      const s = job.stages[name]
      const ms = s.startedAt && s.endedAt ? new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime() : null
      return { name, status: current?.id === job.id && current.stage === name ? 'running' : s.status, ms }
    })
  }

  /** 요약·교정 검증·전사문 다듬기 크레딧의 합. 요약 크레딧을 모르면 null */
  function totalCredits(job: Job): number | null {
    const c = job.cost
    if (c?.summaryCredits == null) return null
    return Math.round((c.summaryCredits + (c.verifyCredits ?? 0) + (c.polishCredits ?? 0)) * 100) / 100
  }

  function view(job: Job, firstQueued: boolean): JobView {
    const live = current?.id === job.id ? current : null
    let etaS: number | null = null
    const durationS = job.audio?.durationS ?? null
    if (live && live.stage === 'stt' && durationS) {
      const elapsedS = (Date.now() - live.stageStartedAt) / 1000
      // 처음엔 이 PC에서 잰 속도로, 어느 정도 진행되면 실제 속도로 남은 시간을 계산한다
      if (live.frac >= 0.05) etaS = (elapsedS / live.frac) * (1 - live.frac)
      else if (probeCache) etaS = estimateSttSeconds(durationS, probeCache) - elapsedS
      if (etaS !== null) etaS = Math.max(0, Math.round(etaS))
    }
    return {
      id: job.id,
      name: basename(job.input.audio),
      subject: job.input.subject,
      status: live ? 'running' : job.status,
      stage: live?.stage ?? null,
      frac: live?.frac ?? 0,
      etaS,
      durationS,
      waiting: job.status === 'queued' || (job.status === 'running' && !live) ? (firstQueued && !d.sttReady() ? 'model' : 'turn') : null,
      error: job.error ?? null,
      notePath: job.output?.notePath ?? null,
      createdAt: job.createdAt,
      recordedAt: job.audio?.recordedAt ?? null,
      language: job.settings.language,
      audioPath: job.input.audio,
      hasNotes: job.input.notes !== null,
      stages: stageViews(job),
      credits: totalCredits(job),
      sttChunks: job.status === 'done' ? null : sttChunks(job),
      autoRetryAt: autoRetryAt.get(job.id) ?? null
    }
  }

  async function list(): Promise<JobView[]> {
    const jobs = (await listJobs(d.dataDir)).reverse() // 최근 것부터
    const pending = jobs.filter((j) => j.status === 'queued' || j.status === 'running').reverse()
    return jobs.map((j) => view(j, pending[0]?.id === j.id && current === null))
  }

  async function emitNow(): Promise<void> {
    lastEmit = Date.now()
    last = await list()
    d.emit(last)
  }

  // 앞에서부터(오래된 것부터) 끝나지 않은 작업. 실행 중이던 작업(앱이 꺼져 멈춘 것)도 다시 돌린다.
  async function nextPending(): Promise<Job | null> {
    return (await listJobs(d.dataDir)).find((j) => j.status === 'queued' || j.status === 'running') ?? null
  }

  function loop(): Promise<void> {
    if (running || stopping) return loopDone
    running = true
    loopDone = run()
    return loopDone
  }

  async function run(): Promise<void> {
    let blocker: number | null = null
    try {
      for (let job = await nextPending(); job && !stopping; job = await nextPending()) {
        blocker ??= powerSaveBlocker.start('prevent-app-suspension') // 작업 중에는 PC가 잠들지 않게
        await emitNow()
        try {
          await d.whenSttReady()
        } catch {
          // 모델을 받지 못함: 작업은 대기로 두고 멈춘다. 화면의 [이어 받기]로 받으면 다시 돈다.
          break
        }
        probeCache = await d.probe()
        const jobDir = dirOf(job.id)
        // 받아쓰기 전이면 지금 설정의 모델·옵션과 잰 장치·스레드로 맞춘다
        // (모델 없이 넣은 작업은 만들 때 장치를 몰랐고, 기다리는 동안 설정에서 모델을 바꿨을 수 있다)
        if (job.stages.stt.status === 'pending') {
          const stt = await d.stt()
          job.settings.model = stt.model
          job.settings.args = stt.args
          if (probeCache) {
            job.settings.gpuDevice = probeCache.gpuDevice
            job.settings.threads = probeCache.threads
          }
          await writeJsonAtomic(join(jobDir, 'job.json'), job)
        }
        if (stopping) break
        current = { id: job.id, stage: 'audio', frac: 0, stageStartedAt: Date.now() }
        controller = new AbortController()
        const ctx: JobContext = {
          ffmpeg: d.ffmpeg(),
          whisperCli: [d.whisperCli()],
          modelPath: async (kind, name) => join(d.dataDir, 'models', MODELS[kind][name].file),
          apiKey: await d.apiKey(),
          signal: controller.signal,
          onProgress: (stage, frac) => {
            if (!current) return
            if (stage !== current.stage) current = { ...current, stage, frac: 0, stageStartedAt: Date.now() }
            current.frac = frac
            if (Date.now() - lastEmit >= EMIT_INTERVAL_MS || frac >= 1) void emitNow()
          }
        }
        try {
          const finished = await runJob(jobDir, ctx)
          await d.onDone?.(finished).catch(() => {}) // 옮기기 실패는 작업 실패가 아니다
        } catch {
          // 실패 이유는 job.json에 남는다 (화면이 error로 보여 준다)
          if (stopping) await requeue(jobDir) // 앱을 끄느라 멈춘 것은 실패가 아니다: 다음에 켜면 이어서 한다
          else await scheduleAutoRetry(job.id)
        }
        controller = null
        current = null
      }
    } finally {
      if (blocker !== null) powerSaveBlocker.stop(blocker)
      current = null
      running = false
      await emitNow()
    }
  }

  async function scheduleAutoRetry(id: string): Promise<void> {
    const job = await loadJob(dirOf(id))
    if (job.error?.code !== 'rate_limit' || autoRetried.has(id)) return
    autoRetried.add(id)
    autoRetryAt.set(id, Date.now() + RATE_LIMIT_RETRY_MS)
    setTimeout(() => {
      if (!autoRetryAt.delete(id)) return // 그사이 사용자가 다시 시도하거나 지움
      void retry(id)
    }, RATE_LIMIT_RETRY_MS)
  }

  /** 작업을 만들고 돌리기 시작한다. 만든 작업 id를 넣은 순서대로 돌려준다. */
  async function start(inputs: JobInput[]): Promise<string[]> {
    const probe = await d.probe()
    const [llm, outDir, stt, steps] = await Promise.all([d.llm(), d.outDir(), d.stt(), d.steps()])
    const ids: string[] = []
    for (const input of inputs) {
      const jobDir = await createJob(d.dataDir, input.audio, input.notes, input.subject, {
        language: input.language,
        model: stt.model,
        beamSize: DEFAULT_BEAM_SIZE,
        gpuDevice: probe?.gpuDevice ?? null,
        threads: probe?.threads ?? (await d.defaultThreads()),
        args: stt.args,
        outDir,
        llm,
        ...steps
      }, input.from)
      ids.push(basename(jobDir))
    }
    await emitNow()
    void loop()
    return ids
  }

  async function save(job: Job): Promise<void> {
    await writeJsonAtomic(join(dirOf(job.id), 'job.json'), job)
  }

  /**
   * 실패·취소한 작업을 끝난 단계 다음부터 다시 한다 (받아쓰기를 다시 하지 않는다).
   * 요약에서 멈춘 작업은 지금 설정의 요약 모델로 다시 한다 (시간 초과 뒤 설정에서 모델을 바꾸고 다시 시도하게).
   */
  async function retry(id: string): Promise<void> {
    autoRetryAt.delete(id)
    const job = await loadJob(dirOf(id))
    if (job.status !== 'failed' && job.status !== 'cancelled') return
    const stage = job.error?.stage
    if ((stage === 'polish' || stage === 'summarize') && job.settings.llm) {
      job.settings.llm = (await d.llm()) ?? job.settings.llm
      job.settings.verifyModel = null // 앱은 교정 검증을 하지 않는다 (검증을 켜고 만든 이전 작업도)
      if (stage === 'polish') job.settings.polishModel = (await d.steps()).polishModel // 다듬기에서 멈췄으면 지금 설정대로(끄면 건너뜀)
    }
    job.status = 'queued'
    delete job.error
    await save(job)
    await emitNow()
    void loop()
  }

  /** 끝난 작업의 요약을 지금 설정(요약 서비스·모델)으로 다시 만들어 같은 노트 파일에 덮어쓴다. 받아쓰기는 다시 하지 않는다. */
  async function resummarize(id: string): Promise<void> {
    const job = await loadJob(dirOf(id))
    if (job.status !== 'done' || job.stages.clean.status !== 'done') throw new EngineError('input', '이 노트는 요약을 다시 만들 수 없어요.')
    const llm = await d.llm()
    if (!llm) throw new EngineError('auth', '요약 서비스를 먼저 연결해 주세요.')
    job.settings.llm = llm
    job.settings.verifyModel = null
    for (const s of ['summarize', 'note', 'save'] as const) job.stages[s] = { status: 'pending' }
    // 다듬은 전사문은 그대로 두고(다시 다듬지 않음) 요약만 다시 한다
    job.cost = job.cost?.polishCredits != null ? { summaryCredits: null, polishCredits: job.cost.polishCredits } : undefined
    job.status = 'queued'
    await save(job)
    await emitNow()
    void loop()
  }

  /** 요약을 건너뛰고 전사문만 담은 노트를 저장한다 (크레딧 부족·너무 긴 전사). 받아쓰기가 끝난 작업만. */
  async function transcriptOnly(id: string): Promise<void> {
    autoRetryAt.delete(id)
    const job = await loadJob(dirOf(id))
    if ((job.status !== 'failed' && job.status !== 'cancelled') || job.stages.stt.status !== 'done') return
    job.settings.llm = null
    if (job.stages.polish?.status !== 'done') job.stages.polish = { status: 'skipped' }
    job.stages.summarize = { status: 'skipped' }
    job.status = 'queued'
    delete job.error
    await save(job)
    await emitNow()
    void loop()
  }

  /** 도는 작업은 받아쓰기를 멈추고(끝난 조각은 남김), 대기 중인 작업은 바로 취소한다. */
  async function cancel(id: string): Promise<void> {
    if (current?.id === id) {
      controller?.abort() // runJob이 취소됨으로 남긴다. 요약 요청 중이면 그 요청이 끝난 뒤 멈춘다
      return
    }
    const job = await loadJob(dirOf(id))
    if (job.status !== 'queued' && job.status !== 'running') return
    job.status = 'cancelled'
    const stage = STAGES.find((s) => job.stages[s].status !== 'done' && job.stages[s].status !== 'skipped') ?? 'save'
    job.error = { code: 'cancelled', message: '작업을 취소했어요.', stage }
    await save(job)
    await emitNow()
  }

  /** 멈춘 작업·취소한 작업의 작업 폴더를 지운다. 녹음과 저장한 노트는 건드리지 않는다. */
  async function remove(id: string): Promise<void> {
    const job = await loadJob(dirOf(id))
    if (job.status !== 'failed' && job.status !== 'cancelled') return
    autoRetryAt.delete(id)
    await rm(dirOf(id), { recursive: true, force: true })
    await emitNow()
  }

  /** 설정 > 저장 공간: 완료한 작업의 작업 폴더를 모두 지운다. 만든 노트와 원래 녹음은 그대로다. 지운 수를 돌려준다. */
  async function clearDone(): Promise<number> {
    const done = (await listJobs(d.dataDir)).filter((j) => j.status === 'done')
    for (const j of done) await rm(dirOf(j.id), { recursive: true, force: true })
    await emitNow()
    return done.length
  }

  async function requeue(jobDir: string): Promise<void> {
    const job = await loadJob(jobDir)
    job.status = 'queued'
    delete job.error
    await writeJsonAtomic(join(jobDir, 'job.json'), job)
  }

  /** 앱을 끌 때: 돌고 있는 받아쓰기를 멈추고(whisper-cli 종료) 작업은 대기로 되돌린다. 최대 waitMs만 기다린다. */
  async function shutdown(waitMs = 5000): Promise<void> {
    stopping = true
    controller?.abort()
    await Promise.race([loopDone, new Promise((r) => setTimeout(r, waitMs))])
  }

  /** 끝난 작업의 노트 경로 (화면이 임의의 경로를 열지 못하게 작업 id로만 연다) */
  async function notePath(id: string): Promise<string | null> {
    return (await loadJob(dirOf(id))).output?.notePath ?? null
  }

  return {
    list,
    start,
    retry,
    transcriptOnly,
    resummarize,
    cancel,
    remove,
    clearDone,
    notePath,
    shutdown,
    kick: () => void loop(),
    /** 대기 중이거나 도는 작업 수 */
    activeCount: () => last.filter((j) => j.status === 'running' || j.status === 'queued').length,
    busy: () => running,
    /** 작업 하나를 처리하는 중 (받아쓰기가 돌 수 있음) */
    transcribing: () => current !== null
  }
}
