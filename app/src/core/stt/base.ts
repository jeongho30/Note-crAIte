// STT 엔진 공통: 조각별로 전사해 저장하고, 조각 시작 시각만큼 밀어서 하나로 합친다.
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Chunk } from '../audio.ts'
import { readJson, writeJsonAtomic } from '../files.ts'

export type Segment = { startMs: number; endMs: number; text: string }
export type OnProgress = (frac: number) => void
export type TranscribeOptions = { language: string; onProgress?: OnProgress; signal?: AbortSignal }

export interface SttEngine {
  transcribe(wav: string, opts: TranscribeOptions): Promise<Segment[]>
  /** VAD 없이 받아쓰는 같은 엔진. VAD를 쓰지 않으면 null (누락 구간을 다시 받아쓸 때 쓴다) */
  withoutVad?(): SttEngine | null
}

// 누락 구간: whisper.cpp는 VAD로 이어 붙인 음성에서 가끔 시각을 크게 건너뛰어, 몇 분짜리 구간에 몇 글자만 남긴다
// (9/30: 63분 강의의 10분 조각에서 433초 구간에 8자, 조각 시작 위치에 따라 생기고 파일 통째로는 안 생김).
// 조용히 말한 부분도 VAD가 놓친다. 이런 구간이 있는 조각만 VAD 없이 한 번 더 받아써서 그 구간을 바꿔 끼운다.
const GAP_MIN_MS = 60_000
const GAP_MAX_CHARS = 60

/** 길이에 비해 글자가 너무 적은 구간 (60초 넘고 60자 미만) */
export function sparseSegments(segments: Segment[]): Segment[] {
  return segments.filter((s) => s.endMs - s.startMs > GAP_MIN_MS && s.text.length < GAP_MAX_CHARS)
}

/** 누락 구간을 VAD 없이 받아쓴 결과의 같은 시간대 구간으로 바꾼다. 나머지는 VAD 결과 그대로 */
export function fillGaps(withVad: Segment[], gaps: Segment[], withoutVad: Segment[]): Segment[] {
  const out = withVad.filter((s) => !gaps.includes(s))
  for (const g of gaps) out.push(...withoutVad.filter((s) => s.startMs >= g.startMs - 1000 && s.startMs < g.endMs))
  return out.sort((a, b) => a.startMs - b.startMs)
}

/** 끝난 조각(part_NNN.json)은 다시 돌리지 않는다. 앱이 꺼져도 끝난 조각부터 이어간다. */
export async function transcribeChunks(engine: SttEngine, chunks: Chunk[], chunkDir: string, partsDir: string,
                                       opts: TranscribeOptions): Promise<Segment[]> {
  await mkdir(partsDir, { recursive: true })
  const total = chunks.reduce((sum, c) => sum + c.endS - c.startS, 0) || 1
  let done = 0
  const merged: Segment[] = []
  for (const [i, c] of chunks.entries()) {
    const span = c.endS - c.startS
    const part = join(partsDir, `part_${String(i).padStart(3, '0')}.json`)
    let segments: Segment[]
    if (existsSync(part)) {
      segments = await readJson<Segment[]>(part)
    } else {
      const base = done
      const wav = join(chunkDir, c.file)
      segments = await engine.transcribe(wav, {
        language: opts.language,
        signal: opts.signal,
        onProgress: (frac) => opts.onProgress?.((base + frac * span) / total)
      })
      const gaps = sparseSegments(segments)
      const plain = gaps.length ? engine.withoutVad?.() : null
      if (plain) segments = fillGaps(segments, gaps, await plain.transcribe(wav, { language: opts.language, signal: opts.signal }))
      await writeJsonAtomic(part, segments)
    }
    const offset = Math.round(c.startS * 1000)
    for (const s of segments) merged.push({ ...s, startMs: s.startMs + offset, endMs: s.endMs + offset })
    done += span
    opts.onProgress?.(done / total)
  }
  return merged
}
