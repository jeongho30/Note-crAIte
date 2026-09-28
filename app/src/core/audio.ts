// 오디오 준비: 16kHz 모노 WAV 변환, 길이·녹음 시각 읽기, 무음 지점에서 조각 나누기.
// convertToWav는 pipeline/process_lecture.py의 convert_to_wav()를 옮겨 온 것이다.
import { mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { EngineError } from './errors.ts'
import { runCapture } from './proc.ts'
import { splitWav, wavDuration } from './wav.ts'

const DURATION_RE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/
const CREATION_RE = /creation_time\s*:\s*(\S+)/
const AUDIO_STREAM_RE = /Stream #\d+:\d+.*?: Audio:/
const SILENCE_START_RE = /silence_start:\s*(-?\d+(?:\.\d+)?)/
const SILENCE_END_RE = /silence_end:\s*(\d+(?:\.\d+)?)/

export type Chunk = { file: string; startS: number; endS: number }
export type ProbeInfo = { durationS: number | null; creationTime: string | null; hasAudio: boolean }

export async function convertToWav(ffmpeg: string, src: string, dst: string): Promise<void> {
  // -vn: mp4·webm 같은 영상 컨테이너도 받으므로 영상 스트림은 버린다.
  const r = await runCapture(ffmpeg, ['-y', '-i', src, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', dst], 'ffmpeg')
  if (r.code !== 0) throw new EngineError('ffmpeg', `ffmpeg 변환 실패:\n${r.stderr.slice(-2000)}`)
}

export function parseProbe(stderr: string): ProbeInfo {
  const m = DURATION_RE.exec(stderr)
  const c = CREATION_RE.exec(stderr) // 처음 나오는 것이 컨테이너 수준 메타데이터
  return {
    durationS: m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null,
    creationTime: c ? c[1] : null,
    hasAudio: AUDIO_STREAM_RE.test(stderr)
  }
}

export async function probe(ffmpeg: string, src: string): Promise<ProbeInfo> {
  // ffprobe를 따로 넣지 않으려고 `ffmpeg -i`의 정보 출력을 읽는다 (출력 파일이 없어 종료 코드는 1).
  const info = parseProbe((await runCapture(ffmpeg, ['-hide_banner', '-i', src], 'ffmpeg')).stderr)
  if (!info.hasAudio) throw new EngineError('input', `오디오를 읽을 수 없는 파일입니다: ${src}`)
  return info
}

export function parseSilences(stderr: string): [number, number][] {
  const silences: [number, number][] = []
  let start: number | null = null
  for (const line of stderr.split(/\r?\n/)) {
    const s = SILENCE_START_RE.exec(line)
    if (s) {
      start = Math.max(0, Number(s[1]))
      continue
    }
    const e = SILENCE_END_RE.exec(line)
    if (e && start !== null) {
      silences.push([start, Number(e[1])])
      start = null
    }
  }
  return silences
}

export async function detectSilences(ffmpeg: string, wav: string, noiseDb = -30, minLenS = 0.4): Promise<[number, number][]> {
  const args = ['-hide_banner', '-nostats', '-i', wav, '-af', `silencedetect=noise=${noiseDb}dB:d=${minLenS}`, '-f', 'null', '-']
  const r = await runCapture(ffmpeg, args, 'ffmpeg')
  if (r.code !== 0) throw new EngineError('ffmpeg', `무음 구간 검출 실패:\n${r.stderr.slice(-2000)}`)
  return parseSilences(r.stderr)
}

/** targetS마다, 앞뒤 windowS 안에서 가장 긴 무음의 가운데를 자른다. 무음이 없으면 목표 지점에서 자른다. */
export function planChunks(durationS: number, silences: [number, number][], targetS = 600, windowS = 30): [number, number][] {
  const cuts: number[] = []
  let last = 0
  while (durationS - last > targetS * 1.5) {
    // 마지막 조각이 너무 짧아지지 않게
    const target = last + targetS
    let best: { len: number; mid: number } | null = null
    for (const [s, e] of silences) {
      const mid = (s + e) / 2
      if (Math.abs(mid - target) <= windowS && (best === null || e - s > best.len)) best = { len: e - s, mid }
    }
    last = best ? best.mid : target
    cuts.push(last)
  }
  const bounds = [0, ...cuts, durationS]
  return bounds.slice(0, -1).map((b, i) => [b, bounds[i + 1]])
}

/** 로컬 STT용 조각(workDir/chunks/part_NNN.wav)을 만든다. 조각을 만든 뒤 원본 WAV는 지운다 (90분에 약 170MB). */
export async function prepareLocal(ffmpeg: string, src: string, workDir: string, targetS = 600): Promise<Chunk[]> {
  const chunkDir = join(workDir, 'chunks')
  await mkdir(chunkDir, { recursive: true })
  const wav = join(workDir, 'input.wav')
  await convertToWav(ffmpeg, src, wav)
  const duration = await wavDuration(wav)
  const bounds: [number, number][] =
    targetS > 0 && duration > targetS * 1.5 ? planChunks(duration, await detectSilences(ffmpeg, wav), targetS) : [[0, duration]]
  const files = bounds.map((_, i) => `part_${String(i).padStart(3, '0')}.wav`)
  await splitWav(wav, bounds, files.map((f) => join(chunkDir, f)))
  await unlink(wav)
  return files.map((file, i) => ({ file, startS: bounds[i][0], endS: bounds[i][1] }))
}
