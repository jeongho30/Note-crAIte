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
      segments = await engine.transcribe(join(chunkDir, c.file), {
        language: opts.language,
        signal: opts.signal,
        onProgress: (frac) => opts.onProgress?.((base + frac * span) / total)
      })
      await writeJsonAtomic(part, segments)
    }
    const offset = Math.round(c.startS * 1000)
    for (const s of segments) merged.push({ ...s, startMs: s.startMs + offset, endMs: s.endMs + offset })
    done += span
    opts.onProgress?.(done / total)
  }
  return merged
}
