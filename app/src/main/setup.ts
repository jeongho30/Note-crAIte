// 받아쓰기 준비: 모델 받기와, 다 받은 뒤 이 PC의 받아쓰기 속도 재기(probe).
// 상태는 메인 프로세스에 두고 바뀔 때마다 화면에 'setup' 이벤트로 보낸다(마법사 단계를 넘겨도 계속 받는다).
// 받아쓰기 모델은 설정 > 고급에서 바꿀 수 있고, 바꾸면 그 모델을 받은 뒤 속도를 다시 잰다.
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ensureModel } from '../core/downloads.ts'
import { EngineError } from '../core/errors.ts'
import { readJson, writeJsonAtomic } from '../core/files.ts'
import { defaultThreads, detect } from '../core/hardware.ts'
import { DEFAULT_BEAM_SIZE, VAD_MODEL } from '../core/job.ts'
import { MODELS } from '../core/models.ts'
import { estimateSttSeconds, probeDevices } from '../core/probe.ts'
import type { ProbeResult } from '../core/probe.ts'

export type SetupState = {
  /** 쓰는 받아쓰기 모델 이름 */
  name: string
  model: { state: 'missing' | 'downloading' | 'ready' | 'error'; done: number; total: number; error?: string }
  probe: {
    state: 'idle' | 'running' | 'done' | 'error'
    gpuName?: string | null
    minutesFor90?: number
    /** 잰 스레드 수·장치 (설정 > 고급의 기본 옵션에 쓴다) */
    threads?: number
    gpuDevice?: number | null
    error?: string
  }
}

type Deps = {
  dataDir: string
  /** 처음 쓸 받아쓰기 모델 (settings.json) */
  model: string
  whisperCli: () => string
  sample: string
  /** 작업이 받아쓰기 중이면 true. 속도 재기는 겹쳐 돌리지 않고 작업이 끝난 뒤 한다 */
  busy: () => boolean
  emit: (state: SetupState) => void
  log: (message: string) => void
}

function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

export function createSetup({ dataDir, model, whisperCli, sample, busy, emit, log }: Deps) {
  const modelsDir = join(dataDir, 'models')
  const probePath = join(dataDir, 'probe.json')
  let name = model
  let probePending = false // 작업 중이라 미뤄 둔 속도 재기

  const files = () => [MODELS.whisper[name], MODELS.vad[VAD_MODEL]]
  const total = () => files().reduce((n, f) => n + f.size, 0)

  // 이미 받은 양 (완성본 + .part). 받다 끊긴 경우 화면이 [이어 받기]를 보인다.
  function received(): number {
    return files().reduce((n, f) => {
      const dest = join(modelsDir, f.file)
      return n + (sizeOf(dest) === f.size ? f.size : sizeOf(dest + '.part'))
    }, 0)
  }

  function modelState(): SetupState['model'] {
    const done = received()
    return { state: done === total() ? 'ready' : 'missing', done, total: total() }
  }

  const state: SetupState = { name, model: modelState(), probe: { state: 'idle' } }

  // whenReady()를 기다리는 작업들
  const waiters: { resolve: () => void; reject: (e: Error) => void }[] = []

  function settle(): void {
    if (state.model.state === 'error') {
      for (const w of waiters.splice(0)) w.reject(new EngineError('download', state.model.error ?? '모델을 받지 못했어요.'))
    } else if (state.model.state === 'ready' && (state.probe.state === 'done' || state.probe.state === 'error')) {
      for (const w of waiters.splice(0)) w.resolve()
    }
  }

  function update(patch: Partial<SetupState>): void {
    Object.assign(state, patch)
    emit(structuredClone(state))
    settle()
  }

  function summarize(p: ProbeResult): SetupState['probe'] {
    const gpuName = p.gpuDevice === null ? null : (p.devices.find((d) => d.index === p.gpuDevice)?.name ?? `GPU ${p.gpuDevice}`)
    return { state: 'done', gpuName, minutesFor90: Math.ceil(estimateSttSeconds(5400, p) / 60), threads: p.threads, gpuDevice: p.gpuDevice }
  }

  async function runProbe(): Promise<void> {
    if (state.probe.state === 'running') return
    // 받아쓰기 중에는 재지 않는다 (두 whisper가 CPU를 나눠 써서 속도도 틀리게 나온다). 작업이 끝나면 resume()이 잰다.
    if (busy()) {
      probePending = true
      update({ probe: { state: 'idle' } })
      return
    }
    probePending = false
    const probing = name
    update({ probe: { state: 'running' } })
    try {
      const result = await probeDevices({
        cli: [whisperCli()],
        model: join(modelsDir, MODELS.whisper[probing].file),
        modelName: probing,
        vadModel: join(modelsDir, MODELS.vad[VAD_MODEL].file),
        threads: defaultThreads(await detect()),
        beamSize: DEFAULT_BEAM_SIZE,
        language: 'ko',
        sample,
        workDir: join(dataDir, 'probe')
      })
      if (probing !== name) return // 재는 동안 모델을 바꿈: 새 모델로 다시 잰다
      await writeJsonAtomic(probePath, result)
      const s = summarize(result)
      log(`속도 재기: ${probing} · ${s.gpuName ?? 'CPU'} · RTF ${result.rtf.toFixed(3)} · 90분 약 ${s.minutesFor90}분`)
      update({ probe: s })
    } catch (e) {
      if (probing !== name) return
      const error = (e as Error).message.split('\n')[0]
      log(`속도 재기 실패: ${probing} · ${error}`)
      update({ probe: { state: 'error', error } })
    }
  }

  async function download(): Promise<void> {
    if (state.model.state === 'downloading' || state.model.state === 'ready') return
    const downloading = name
    let before = 0
    update({ model: { state: 'downloading', done: received(), total: total() } })
    try {
      for (const [kind, entry] of [['whisper', downloading], ['vad', VAD_MODEL]] as const) {
        const size = MODELS[kind][entry].size
        let last = 0
        await ensureModel(kind, entry, modelsDir, (have) => {
          // 화면 갱신은 1MB마다만
          if (have - last < 1_000_000 && have !== size) return
          last = have
          if (downloading === name) update({ model: { state: 'downloading', done: before + have, total: total() } })
        })
        before += size
      }
      if (downloading !== name) return
      log(`모델 받음: ${downloading}`)
      update({ model: { state: 'ready', done: total(), total: total() } })
      void runProbe()
    } catch (e) {
      const message = e instanceof EngineError ? e.message : '모델을 받다가 문제가 생겼어요. 다시 시도하면 이어서 받아요.'
      log(`모델 받기 실패: ${downloading} · ${message}`)
      if (downloading === name) update({ model: { state: 'error', done: received(), total: total(), error: message } })
    }
  }

  async function savedProbe(): Promise<SetupState['probe'] | null> {
    try {
      const p = await readJson<ProbeResult>(probePath)
      return p.model === name ? summarize(p) : null
    } catch {
      return null // 아직 잰 적 없음
    }
  }

  // 설정의 받아쓰기 모델로 시작한다. 모델은 있는데 이 모델로 잰 속도가 없으면(측정 중에 앱을 껐던 경우) 다시 잰다.
  async function init(model: string): Promise<void> {
    if (MODELS.whisper[model] && model !== name) {
      name = model
      state.name = name
      state.model = modelState()
    }
    const sizes = files().map((f) => `${f.file} ${sizeOf(join(modelsDir, f.file))}/${f.size}`)
    log(`받아쓰기 모델: ${name} · ${state.model.state} · ${modelsDir} · ${sizes.join(', ')}`)
    const saved = await savedProbe()
    if (saved) state.probe = saved
    if (state.model.state === 'ready' && state.probe.state === 'idle') void runProbe()
  }

  /** 받아쓰기 모델을 바꾼다. 없으면 받고, 있으면 (이 모델로 잰 적이 없을 때) 속도를 다시 잰다. */
  async function setModel(next: string): Promise<void> {
    if (!MODELS.whisper[next]) throw new EngineError('input', `모르는 모델이에요: ${next}`)
    if (next === name) return
    if (state.model.state === 'downloading') throw new EngineError('input', '모델을 받는 중이에요. 다 받은 뒤 바꿔 주세요.')
    name = next
    state.name = name
    state.model = modelState()
    state.probe = (await savedProbe()) ?? { state: 'idle' }
    update({})
    if (state.model.state === 'missing') void download()
    else if (state.probe.state === 'idle') void runProbe()
  }

  /** [속도 다시 재기] */
  function reprobe(): void {
    if (state.model.state !== 'ready') throw new EngineError('input', '받아쓰기 모델을 받은 뒤 잴 수 있어요.')
    if (busy()) throw new EngineError('input', '받아쓰기 중에는 속도를 잴 수 없어요. 작업이 끝난 뒤 다시 해 주세요.')
    void runProbe()
  }

  /** 작업이 끝나 한가해졌을 때: 미뤄 둔 속도 재기를 한다. */
  function resume(): void {
    if (probePending && !busy() && state.model.state === 'ready') void runProbe()
  }

  /**
   * 받아쓰기를 시작해도 되면(모델이 있고 속도 재기가 끝남) 끝난다. 모델이 없으면 받기를 시작한다
   * (마법사에서 건너뛴 사람이 녹음을 넣고 [받고 시작]을 누른 경우). 속도를 재는 동안 받아쓰기를 겹쳐 돌리지 않는다.
   */
  function whenReady(): Promise<void> {
    const p = new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }))
    if (state.model.state === 'missing' || state.model.state === 'error') void download()
    else if (state.model.state === 'ready' && state.probe.state === 'idle') {
      probePending = true
      resume()
    }
    settle()
    return p
  }

  return { get: () => structuredClone(state), download, init, whenReady, setModel, reprobe, resume, model: () => name }
}
