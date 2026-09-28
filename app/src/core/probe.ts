// 이 PC에서 STT를 CPU와 GPU 중 어디서 돌릴지 정하고, 예상 시간에 쓸 속도(RTF)를 잰다.
// 장치 목록만 믿지 않고 짧은 샘플을 장치마다 실제로 돌려 본다: 데스크톱 내장 GPU는 CPU보다 3배 느렸고,
// 노트북 내장 GPU는 전사가 깨졌다 (docs/decisions.md S3).
import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { cer, normalize } from './compare.ts'
import { EngineError } from './errors.ts'
import { backendUsed, WhisperCpp } from './stt/whispercpp.ts'
import { wavDuration } from './wav.ts'

const VK_DEVICE_RE = /ggml_vulkan: (\d+) = (.+?) \| uma: (\d)/
const TIMING_RE = /whisper_print_timings:\s+(load|total) time =\s+([\d.]+) ms/

// GPU 전사가 CPU 전사와 이만큼 다르면 깨진 것으로 본다. 정상이면 같은 모델이라 거의 같다.
const MAX_CER_VS_CPU = 0.3
// GPU가 이만큼 빠르지 않으면 CPU를 쓴다 (내장 GPU와 나눠 쓰는 메모리 등 이득이 불분명한 경우).
const MIN_SPEEDUP = 1.2

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
}

export async function probeDevices(o: ProbeOptions): Promise<ProbeResult> {
  await mkdir(o.workDir, { recursive: true })
  const wav = join(o.workDir, 'sample.wav')
  await copyFile(o.sample, wav)
  const sampleS = await wavDuration(wav)

  async function trial(device: number | null, name: string, cpuText: string | null): Promise<[Trial, string, string[]]> {
    o.onTrial?.(name)
    const engine = new WhisperCpp({
      cli: o.cli, model: o.model, vadModel: o.vadModel, threads: o.threads, gpuDevice: device, beamSize: o.beamSize, quiet: false
    })
    let text = ''
    try {
      text = (await engine.transcribe(wav, { language: o.language })).map((s) => s.text).join(' ')
    } catch (e) {
      if (device === null) throw e
      return [{ device, name, processMs: 0, loadMs: 0, chars: 0, ok: false, reason: (e as Error).message.split('\n')[0] }, '', engine.lastLog]
    }
    const { loadMs, totalMs } = parseTimings(engine.lastLog)
    const t: Trial = {
      device, name, processMs: (totalMs ?? 0) - (loadMs ?? 0), loadMs: loadMs ?? 0, chars: normalize(text).length, ok: true
    }
    if (device !== null && backendUsed(engine.lastLog) !== `Vulkan${device}`) {
      Object.assign(t, { ok: false, reason: 'GPU를 쓰지 못하고 CPU로 돌았습니다' })
    } else if (cpuText !== null && cer(cpuText, text) > MAX_CER_VS_CPU) {
      Object.assign(t, { ok: false, reason: `전사가 CPU 결과와 크게 다릅니다 (CER ${cer(cpuText, text).toFixed(2)})` })
    } else if (!t.chars) {
      Object.assign(t, { ok: false, reason: '전사 결과가 비었습니다' })
    }
    return [t, text, engine.lastLog]
  }

  const [cpu, cpuText, cpuLog] = await trial(null, 'CPU', null)
  const devices = parseVulkanDevices(cpuLog)
  const trials = [cpu]
  for (const d of devices) trials.push((await trial(d.index, d.name, cpuText))[0])
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

/** 로컬 STT 예상 시간(초): 처리 속도 × 길이 + 약 10분 조각마다 모델 로드. */
export function estimateSttSeconds(durationS: number, p: Pick<ProbeResult, 'rtf' | 'loadS'>): number {
  return durationS * p.rtf + Math.ceil(durationS / 600) * p.loadS
}

// 받아쓰기 밖의 단계 (데스크톱 63분 강의 실측, 9/29): 오디오 준비 1.2~1.4초, 요약 5.6~11.4초. 넉넉하게 잡는다.
const PREP_S_PER_AUDIO_S = 1 / 1800
const SUMMARY_S = 15

/** 작업 하나의 예상 총 소요 시간(초): 오디오 준비 + 받아쓰기 + 요약(할 때만). */
export function estimateJobSeconds(durationS: number, p: Pick<ProbeResult, 'rtf' | 'loadS'>, withSummary: boolean): number {
  return durationS * PREP_S_PER_AUDIO_S + estimateSttSeconds(durationS, p) + (withSummary ? SUMMARY_S : 0)
}
