// 받아쓰기 준비: 모델 받기와, 다 받은 뒤 이 PC의 받아쓰기 속도 재기(probe).
// 상태는 메인 프로세스에 두고 바뀔 때마다 화면에 'setup' 이벤트로 보낸다(마법사 단계를 넘겨도 계속 받는다).
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ensureModel } from '../core/downloads.ts'
import { EngineError } from '../core/errors.ts'
import { readJson, writeJsonAtomic } from '../core/files.ts'
import { defaultThreads, detect } from '../core/hardware.ts'
import { DEFAULT_BEAM_SIZE, DEFAULT_MODEL, VAD_MODEL } from '../core/job.ts'
import { MODELS } from '../core/models.ts'
import { estimateSttSeconds, probeDevices } from '../core/probe.ts'
import type { ProbeResult } from '../core/probe.ts'

export type SetupState = {
  model: { state: 'missing' | 'downloading' | 'ready' | 'error'; done: number; total: number; error?: string }
  probe: { state: 'idle' | 'running' | 'done' | 'error'; gpuName?: string | null; minutesFor90?: number; error?: string }
}

type Deps = {
  dataDir: string
  whisperCli: () => string
  sample: string
  emit: (state: SetupState) => void
}

const FILES = [MODELS.whisper[DEFAULT_MODEL], MODELS.vad[VAD_MODEL]]
const TOTAL = FILES.reduce((n, f) => n + f.size, 0)

function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

export function createSetup({ dataDir, whisperCli, sample, emit }: Deps) {
  const modelsDir = join(dataDir, 'models')
  const probePath = join(dataDir, 'probe.json')

  // 이미 받은 양 (완성본 + .part). 받다 끊긴 경우 화면이 [이어 받기]를 보인다.
  function received(): number {
    return FILES.reduce((n, f) => {
      const dest = join(modelsDir, f.file)
      return n + (sizeOf(dest) === f.size ? f.size : sizeOf(dest + '.part'))
    }, 0)
  }

  const done = received()
  const state: SetupState = {
    model: { state: done === TOTAL ? 'ready' : 'missing', done, total: TOTAL },
    probe: { state: 'idle' }
  }

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
    return { state: 'done', gpuName, minutesFor90: Math.ceil(estimateSttSeconds(5400, p) / 60) }
  }

  async function runProbe(): Promise<void> {
    if (state.probe.state === 'running') return
    update({ probe: { state: 'running' } })
    try {
      const result = await probeDevices({
        cli: [whisperCli()],
        model: join(modelsDir, MODELS.whisper[DEFAULT_MODEL].file),
        modelName: DEFAULT_MODEL,
        vadModel: join(modelsDir, MODELS.vad[VAD_MODEL].file),
        threads: defaultThreads(await detect()),
        beamSize: DEFAULT_BEAM_SIZE,
        language: 'ko',
        sample,
        workDir: join(dataDir, 'probe')
      })
      await writeJsonAtomic(probePath, result)
      update({ probe: summarize(result) })
    } catch (e) {
      update({ probe: { state: 'error', error: (e as Error).message.split('\n')[0] } })
    }
  }

  async function download(): Promise<void> {
    if (state.model.state === 'downloading' || state.model.state === 'ready') return
    let before = 0
    update({ model: { state: 'downloading', done: received(), total: TOTAL } })
    try {
      for (const [kind, name] of [['whisper', DEFAULT_MODEL], ['vad', VAD_MODEL]] as const) {
        const entry = MODELS[kind][name]
        let last = 0
        await ensureModel(kind, name, modelsDir, (have) => {
          // 화면 갱신은 1MB마다만
          if (have - last < 1_000_000 && have !== entry.size) return
          last = have
          update({ model: { state: 'downloading', done: before + have, total: TOTAL } })
        })
        before += entry.size
      }
      update({ model: { state: 'ready', done: TOTAL, total: TOTAL } })
      void runProbe()
    } catch (e) {
      const message = e instanceof EngineError ? e.message : '모델을 받다가 문제가 생겼어요. 다시 시도하면 이어서 받아요.'
      update({ model: { state: 'error', done: received(), total: TOTAL, error: message } })
    }
  }

  // 모델은 있는데 이 모델로 잰 속도가 없으면(측정 중에 앱을 껐던 경우) 다시 잰다.
  async function init(): Promise<void> {
    try {
      const p = await readJson<ProbeResult>(probePath)
      if (p.model === DEFAULT_MODEL) state.probe = summarize(p)
    } catch {
      // 아직 잰 적 없음
    }
    if (state.model.state === 'ready' && state.probe.state === 'idle') void runProbe()
  }

  /**
   * 받아쓰기를 시작해도 되면(모델이 있고 속도 재기가 끝남) 끝난다. 모델이 없으면 받기를 시작한다
   * (마법사에서 건너뛴 사람이 녹음을 넣고 [받고 시작]을 누른 경우). 속도를 재는 동안 받아쓰기를 겹쳐 돌리지 않는다.
   */
  function whenReady(): Promise<void> {
    const p = new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }))
    if (state.model.state === 'missing' || state.model.state === 'error') void download()
    else if (state.model.state === 'ready' && state.probe.state === 'idle') void runProbe()
    settle()
    return p
  }

  return { get: () => structuredClone(state), download, init, whenReady }
}
