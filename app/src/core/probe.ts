// 이 PC에서 STT를 CPU와 GPU 중 어디서 돌릴지 정하고, 예상 시간에 쓸 속도(RTF)를 잰다.
// 장치 목록만 믿지 않고 짧은 샘플을 장치마다 실제로 돌려 본다: 데스크톱 내장 GPU는 CPU보다 3배 느렸고,
// 노트북 내장 GPU는 전사가 깨졌다 (docs/decisions.md S3).
import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { cer, normalize } from './compare.ts'
import { EngineError } from './errors.ts'
import type { Job } from './job.ts'
import { backendUsed, WhisperCpp } from './stt/whispercpp.ts'
import { wavDuration } from './wav.ts'

const VK_DEVICE_RE = /ggml_vulkan: (\d+) = (.+?) \| uma: (\d)/
// macOS(Metal): "ggml_metal_device_init: GPU name:   MTL0 (Apple M2)"
const METAL_NAME_RE = /GPU name:\s+MTL\d+ \((.+)\)\s*$/
const TIMING_RE = /whisper_print_timings:\s+(load|total) time =\s+([\d.]+) ms/

// GPU 전사가 CPU 전사와 이만큼 다르면 깨진 것으로 본다. 정상이면 같은 모델이라 거의 같다.
const MAX_CER_VS_CPU = 0.3
// GPU가 이만큼 빠르지 않으면 CPU를 쓴다 (내장 GPU와 나눠 쓰는 메모리 등 이득이 불분명한 경우).
const MIN_SPEEDUP = 1.2
// GPU로 재는 데 이보다 오래 걸리면 그만두고 그 GPU는 쓰지 않는다: CPU로 잰 시간의 몇 배(그만큼 느리면 어차피 안 쓴다), 적어도 2분.
// GPU 쪽이 멈춰 버리면 속도 재기가 끝나지 않아 앱이 작업을 시작하지 못한다. 처음 쓸 때 셰이더를 만드는 시간(Metal은 수십 초)은 들어가게 둔다
const GPU_TRIAL_VS_CPU = 5
const GPU_TRIAL_MIN_MS = 120_000

export type GpuDevice = { index: number; name: string; integrated: boolean }

export type Trial = {
  device: number | null // null이면 CPU
  name: string
  processMs: number // 모델 로드를 뺀 처리 시간
  loadMs: number
  chars: number
  ok: boolean
  reason?: string
}

export type ProbeResult = {
  checkedAt: string
  model: string
  threads: number
  sampleS: number
  devices: GpuDevice[]
  trials: Trial[]
  gpuDevice: number | null // 고른 장치. null이면 CPU
  rtf: number // 고른 장치의 처리 시간 ÷ 녹음 길이
  loadS: number // 조각마다 드는 모델 로드 시간
}

export function parseVulkanDevices(log: string[]): GpuDevice[] {
  const devices = new Map<number, GpuDevice>()
  for (const line of log) {
    const m = VK_DEVICE_RE.exec(line)
    if (m) devices.set(Number(m[1]), { index: Number(m[1]), name: m[2].trim(), integrated: m[3] === '1' })
  }
  return [...devices.values()]
}

/** Metal로 돌린 로그에서 그래픽 장치 이름(Apple Silicon은 칩 이름)을 읽는다. 없으면 null */
export function parseMetalName(log: string[]): string | null {
  for (const line of log) {
    const m = METAL_NAME_RE.exec(line)
    if (m) return m[1].trim()
  }
  return null
}

export function parseTimings(log: string[]): { loadMs: number | null; totalMs: number | null } {
  let loadMs: number | null = null
  let totalMs: number | null = null
  for (const line of log) {
    const m = TIMING_RE.exec(line)
    if (m?.[1] === 'load') loadMs = Number(m[2])
    else if (m?.[1] === 'total') totalMs = Number(m[2])
  }
  return { loadMs, totalMs }
}

/** 정상인 GPU 중 가장 빠른 것을, CPU보다 MIN_SPEEDUP배 이상 빠를 때만 고른다. */
export function choose(trials: Trial[]): Trial {
  const cpu = trials.find((t) => t.device === null)
  if (!cpu?.ok) throw new EngineError('stt_failed', 'CPU로도 샘플을 전사하지 못했습니다.')
  const gpus = trials.filter((t) => t.device !== null && t.ok).sort((a, b) => a.processMs - b.processMs)
  return gpus[0] && gpus[0].processMs * MIN_SPEEDUP <= cpu.processMs ? gpus[0] : cpu
}

export type ProbeOptions = {
  cli: string[]
  model: string // 모델 파일 경로
  modelName: string
  vadModel: string
  threads: number
  beamSize: number
  language: string
  sample: string // 16kHz 모노 WAV
  workDir: string // 샘플을 복사해 돌릴 폴더 (whisper가 샘플 옆에 결과 JSON을 쓴다)
  onTrial?: (name: string) => void
  platform?: string // 테스트용. 기본은 이 PC
  gpuTrialLimitMs?: number // 테스트용. 기본은 CPU로 잰 시간에서 계산
}

export async function probeDevices(o: ProbeOptions): Promise<ProbeResult> {
  await mkdir(o.workDir, { recursive: true })
  const wav = join(o.workDir, 'sample.wav')
  await copyFile(o.sample, wav)
  const sampleS = await wavDuration(wav)
  // macOS의 whisper-cli는 Vulkan이 아니라 Metal로 그래픽 장치를 쓴다 (백엔드 이름 MTL0)
  const metal = (o.platform ?? process.platform) === 'darwin'

  async function trial(device: number | null, name: string, cpuText: string | null, limitMs?: number): Promise<[Trial, string, string[]]> {
    o.onTrial?.(name)
    const engine = new WhisperCpp({
      cli: o.cli, model: o.model, vadModel: o.vadModel, threads: o.threads, gpuDevice: device, beamSize: o.beamSize, quiet: false
    })
    const signal = limitMs ? AbortSignal.timeout(limitMs) : undefined
    let text = ''
    try {
      text = (await engine.transcribe(wav, { language: o.language, signal })).map((s) => s.text).join(' ')
    } catch (e) {
      if (device === null) throw e
      const reason = signal?.aborted ? `너무 오래 걸려 그만뒀습니다 (${Math.round(limitMs! / 1000)}초)` : (e as Error).message.split('\n')[0]
      return [{ device, name, processMs: 0, loadMs: 0, chars: 0, ok: false, reason }, '', engine.lastLog]
    }
    const { loadMs, totalMs } = parseTimings(engine.lastLog)
    const t: Trial = {
      device, name, processMs: (totalMs ?? 0) - (loadMs ?? 0), loadMs: loadMs ?? 0, chars: normalize(text).length, ok: true
    }
    if (device !== null && backendUsed(engine.lastLog) !== `${metal ? 'MTL' : 'Vulkan'}${device}`) {
      Object.assign(t, { ok: false, reason: 'GPU를 쓰지 못하고 CPU로 돌았습니다' })
    } else if (cpuText !== null && cer(cpuText, text) > MAX_CER_VS_CPU) {
      Object.assign(t, { ok: false, reason: `전사가 CPU 결과와 크게 다릅니다 (CER ${cer(cpuText, text).toFixed(2)})` })
    } else if (!t.chars) {
      Object.assign(t, { ok: false, reason: '전사 결과가 비었습니다' })
    }
    return [t, text, engine.lastLog]
  }

  const cpuStarted = Date.now()
  const [cpu, cpuText, cpuLog] = await trial(null, 'CPU', null)
  const gpuLimitMs = o.gpuTrialLimitMs ?? Math.max(GPU_TRIAL_MIN_MS, (Date.now() - cpuStarted) * GPU_TRIAL_VS_CPU)
  // Vulkan은 CPU로 돌 때도 장치 목록을 찍는다. Metal은 목록이 없어 0번(Apple Silicon의 GPU는 하나)을 재 보고, 이름은 그 로그에서 읽는다
  const devices: GpuDevice[] = metal ? [{ index: 0, name: 'Metal', integrated: true }] : parseVulkanDevices(cpuLog)
  const trials = [cpu]
  for (const d of devices) {
    const [t, , log] = await trial(d.index, d.name, cpuText, gpuLimitMs)
    if (metal) d.name = t.name = parseMetalName(log) ?? d.name
    trials.push(t)
  }
  const chosen = choose(trials)
  return {
    checkedAt: new Date().toISOString(),
    model: o.modelName,
    threads: o.threads,
    sampleS,
    devices,
    trials,
    gpuDevice: chosen.device,
    rtf: chosen.processMs / 1000 / sampleS,
    loadS: chosen.loadMs / 1000
  }
}

export type SampleTestOptions = {
  cli: string[]
  model: string
  vadModel: string
  args: string[] // 설정 > 고급에서 고친 옵션
  language: string
  sample: string // 16kHz 모노 WAV
  script: string | null // 샘플의 대본. 있으면 전사와 비교해 정상인지 본다
  workDir: string
}

export type SampleTest = { sampleS: number; processS: number; chars: number; ok: boolean; reason?: string }

/** 고친 옵션으로 샘플을 한 번 전사해 걸린 시간과 결과가 정상인지 본다 (설정 > 받아쓰기 세부설정의 [샘플로 시험하기]). */
export async function testSample(o: SampleTestOptions): Promise<SampleTest> {
  await mkdir(o.workDir, { recursive: true })
  const wav = join(o.workDir, 'sample.wav')
  await copyFile(o.sample, wav)
  const sampleS = await wavDuration(wav)
  const engine = new WhisperCpp({ cli: o.cli, model: o.model, vadModel: o.vadModel, threads: 1, gpuDevice: null, args: o.args, quiet: false })
  let text: string
  try {
    text = (await engine.transcribe(wav, { language: o.language })).map((s) => s.text).join(' ')
  } catch (e) {
    const tail = (e as Error).message.split('\n').filter(Boolean).at(-1) ?? ''
    return { sampleS, processS: 0, chars: 0, ok: false, reason: `whisper-cli가 실패했어요: ${tail}` }
  }
  const { loadMs, totalMs } = parseTimings(engine.lastLog)
  const result: SampleTest = { sampleS, processS: ((totalMs ?? 0) - (loadMs ?? 0)) / 1000, chars: normalize(text).length, ok: true }
  if (!result.chars) Object.assign(result, { ok: false, reason: '전사 결과가 비었어요' })
  else if (o.script !== null && cer(o.script, text) > MAX_CER_VS_CPU) {
    Object.assign(result, { ok: false, reason: `전사가 대본과 크게 달라요 (CER ${cer(o.script, text).toFixed(2)})` })
  }
  return result
}

// 속도 재기 샘플은 쉼 없이 읽은 39초라 실제 강의(쉬는 곳을 VAD가 걸러 냄)보다 느리게 나온다.
// 10/1 노트북 82분 강의: 실제 ÷ 잰 값이 turbo-q8_0 0.62, small-q5_1 0.65
const SAMPLE_TO_LECTURE = 0.65
const HISTORY_MIN_S = 300 // 이보다 짧은 녹음은 모델 로드 비중이 커서 뺀다
const HISTORY_JOBS = 5

export type SttSpeed = Pick<ProbeResult, 'rtf' | 'loadS'>

/**
 * 예상 시간에 쓸 받아쓰기 속도. 같은 모델·장치·스레드·옵션으로 이 PC에서 끝낸 최근 작업들의 실제 속도(중앙값)를 쓰고,
 * 그런 작업이 없으면 잰 속도에 보정을 곱한다. 이어서 한 받아쓰기(resumed)는 걸린 시간이 일부라 뺀다.
 * jobs는 오래된 것부터(listJobs 순서).
 */
export function sttSpeed(probe: ProbeResult, jobs: Job[], args: string[] | null): SttSpeed {
  const sameArgs = JSON.stringify(args ?? null)
  const rates: number[] = []
  for (const j of jobs) {
    const stt = j.stages?.stt
    const durationS = j.audio?.durationS
    if (!stt || stt.status !== 'done' || stt.resumed || !stt.startedAt || !stt.endedAt) continue
    if (!durationS || durationS < HISTORY_MIN_S || j.settings.sttService === 'chatkhu') continue
    if (j.settings.model !== probe.model || j.settings.gpuDevice !== probe.gpuDevice || j.settings.threads !== probe.threads) continue
    if (JSON.stringify(j.settings.args ?? null) !== sameArgs) continue
    const tookS = (Date.parse(stt.endedAt) - Date.parse(stt.startedAt)) / 1000
    if (tookS > 0) rates.push(tookS / durationS)
  }
  if (!rates.length) return { rtf: probe.rtf * SAMPLE_TO_LECTURE, loadS: probe.loadS }
  const recent = rates.slice(-HISTORY_JOBS).sort((a, b) => a - b)
  const mid = recent.length >> 1
  const median = recent.length % 2 ? recent[mid] : (recent[mid - 1] + recent[mid]) / 2
  return { rtf: median, loadS: 0 } // 실제 기록에는 모델 로드가 들어 있다
}

/** 로컬 STT 예상 시간(초): 처리 속도 × 길이 + 약 10분 조각마다 모델 로드. p는 sttSpeed()로 얻는다. */
export function estimateSttSeconds(durationS: number, p: SttSpeed): number {
  return durationS * p.rtf + Math.ceil(durationS / 600) * p.loadS
}

// 받아쓰기 밖의 단계 (데스크톱 63분 강의 실측, 9/29): 오디오 준비 1.2~1.4초. 넉넉하게 잡는다.
const PREP_S_PER_AUDIO_S = 1 / 1800
// 요약에 걸리는 시간(초). 기록이 없을 때 쓰는 값: 요약 서비스(luna)는 주제별 틀(10/2)부터 48~167분 강의에 16~30초로 길이와 거의 상관없다.
// 로컬 LLM은 PC와 모델에 따라 크게 달라서 넉넉하게 잡는다 (gemma 12B, RX 9070 XT: 90분 분량 22초).
const SUMMARY_S = { service: 25, local: 90 }

type LlmTarget = { endpoint: string; model: string; ollama?: unknown }
const median = (xs: number[]): number => {
  const recent = xs.slice(-HISTORY_JOBS).sort((a, b) => a - b)
  const mid = recent.length >> 1
  return recent.length % 2 ? recent[mid] : (recent[mid - 1] + recent[mid]) / 2
}

/**
 * 예상 시간에 쓸 요약 시간(초). 요약하지 않으면 0.
 * 같은 주소·모델로 끝낸 최근 요약들의 실제 시간(중앙값)을 쓰고, 없으면 SUMMARY_S. 요약은 길이와 거의 상관없어 비율이 아니라 시간으로 본다.
 */
export function summarySeconds(jobs: Job[], target: LlmTarget | null): number {
  if (!target) return 0
  const times: number[] = []
  for (const j of jobs) {
    const st = j.stages?.summarize
    const used = j.settings.llm
    if (!st || st.status !== 'done' || st.resumed || !st.startedAt || !st.endedAt || !used) continue
    if (used.endpoint !== target.endpoint || used.model !== target.model) continue
    const tookS = (Date.parse(st.endedAt) - Date.parse(st.startedAt)) / 1000
    if (tookS > 0) times.push(tookS)
  }
  return times.length ? median(times) : target.ollama ? SUMMARY_S.local : SUMMARY_S.service
}

// 전사문 다듬기에 걸리는 시간 ÷ 녹음 길이. 기록이 없을 때 쓰는 값 (10/3~4 데스크톱 실측):
// 요약 서비스(luna, 4조각 동시)는 48분에 52초·64분에 53초, 로컬 LLM(gemma 12B, RX 9070 XT, 한 조각씩)은 48분에 72초·64분에 약 3분.
// 로컬은 PC와 모델에 따라 크게 달라서 넉넉하게 잡고, 한 번 돌리고 나면 그 기록으로 바뀐다.
const POLISH_RATE = { service: 0.02, local: 0.05 }

/**
 * 예상 시간에 쓸 전사문 다듬기 속도(걸린 시간 ÷ 녹음 길이). 다듬지 않으면 0.
 * 같은 주소·모델로 끝낸 최근 작업들의 실제 값(중앙값)을 쓰고, 없으면 POLISH_RATE. 이어서 한 다듬기(resumed)는 뺀다.
 */
export function polishRate(jobs: Job[], target: LlmTarget | null): number {
  if (!target) return 0
  const rates: number[] = []
  for (const j of jobs) {
    const st = j.stages?.polish
    const used = j.settings.polishLlm
    const durationS = j.audio?.durationS
    if (!st || st.status !== 'done' || st.resumed || !st.startedAt || !st.endedAt || !used) continue
    if (!durationS || durationS < HISTORY_MIN_S || used.endpoint !== target.endpoint || used.model !== target.model) continue
    const tookS = (Date.parse(st.endedAt) - Date.parse(st.startedAt)) / 1000
    if (tookS > 0) rates.push(tookS / durationS)
  }
  return rates.length ? median(rates) : target.ollama ? POLISH_RATE.local : POLISH_RATE.service
}

/**
 * 작업 하나의 예상 총 소요 시간(초): 오디오 준비 + 받아쓰기 + 다듬기 + 요약.
 * summaryS는 summarySeconds(), polish는 polishRate()로 얻는다 (그 단계를 안 하면 0).
 */
export function estimateJobSeconds(durationS: number, p: SttSpeed, summaryS: number, polish = 0): number {
  return durationS * PREP_S_PER_AUDIO_S + estimateSttSeconds(durationS, p) + durationS * polish + summaryS
}
