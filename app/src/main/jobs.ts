// 작업 실행기: 시작 전 확인에서 넣은 녹음을 작업으로 만들고, 한 번에 하나씩 돌린다.
// 진행 상황은 바뀔 때마다 화면에 'jobs' 이벤트로 보낸다. 앱을 껐다 켜면 끝나지 않은 작업을 이어서 한다.
import { powerSaveBlocker } from 'electron'
import { basename, join } from 'node:path'
import { writeJsonAtomic } from '../core/files.ts'
import { createJob, DEFAULT_BEAM_SIZE, DEFAULT_MODEL, jobsDir, listJobs, loadJob, runJob } from '../core/job.ts'
import type { Job, JobContext, LlmSettings, StageName } from '../core/job.ts'
import { MODELS } from '../core/models.ts'
import { estimateSttSeconds } from '../core/probe.ts'
import type { ProbeResult } from '../core/probe.ts'
import type { Language } from '../core/settings.ts'

export type JobInput = { audio: string; notes: string | null; subject: string | null; language: Language }

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
  /** 작업을 만들 때의 요약 설정과, 실행할 때의 API 키 */
  llm: () => Promise<LlmSettings | null>
  apiKey: () => Promise<string | null>
  outDir: () => Promise<string>
  emit: (jobs: JobView[]) => void
}

const EMIT_INTERVAL_MS = 500

export function createJobRunner(d: Deps) {
  let running = false
  let current: { id: string; stage: StageName; frac: number; stageStartedAt: number } | null = null
  let lastEmit = 0
  let probeCache: ProbeResult | null = null
  let last: JobView[] = [] // 마지막으로 보낸 목록 (트레이·창 닫기 판단용)
  let loopDone: Promise<void> = Promise.resolve()
  let controller: AbortController | null = null
  let stopping = false

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
      notePath: job.output?.notePath ?? null
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
        const jobDir = join(jobsDir(d.dataDir), job.id)
        // 받아쓰기 전이면 지금 잰 장치·스레드로 맞춘다 (모델 없이 넣은 작업은 만들 때 몰랐다)
        if (job.stages.stt.status === 'pending' && probeCache) {
          job.settings.gpuDevice = probeCache.gpuDevice
          job.settings.threads = probeCache.threads
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
          await runJob(jobDir, ctx)
        } catch {
          // 실패 이유는 job.json에 남는다 (화면이 error로 보여 준다)
          if (stopping) await requeue(jobDir) // 앱을 끄느라 멈춘 것은 실패가 아니다: 다음에 켜면 이어서 한다
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

  async function start(inputs: JobInput[]): Promise<void> {
    const probe = await d.probe()
    const [llm, outDir] = await Promise.all([d.llm(), d.outDir()])
    for (const input of inputs) {
      await createJob(d.dataDir, input.audio, input.notes, input.subject, {
        language: input.language,
        model: DEFAULT_MODEL,
        beamSize: DEFAULT_BEAM_SIZE,
        gpuDevice: probe?.gpuDevice ?? null,
        threads: probe?.threads ?? (await d.defaultThreads()),
        outDir,
        llm
      })
    }
    await emitNow()
    void loop()
  }

  /** 실패·취소한 작업을 끝난 단계 다음부터 다시 한다 (받아쓰기를 다시 하지 않는다). */
  async function retry(id: string): Promise<void> {
    const jobDir = join(jobsDir(d.dataDir), id)
    const job = await loadJob(jobDir)
    if (job.status !== 'failed' && job.status !== 'cancelled') return
    job.status = 'queued'
    await writeJsonAtomic(join(jobDir, 'job.json'), job)
    void loop()
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

  return {
    list,
    start,
    retry,
    shutdown,
    kick: () => void loop(),
    /** 대기 중이거나 도는 작업 수 */
    activeCount: () => last.filter((j) => j.status === 'running' || j.status === 'queued').length,
    busy: () => running
  }
}

