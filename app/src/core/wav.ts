// PCM WAV 읽기·자르기. ffmpeg가 만든 WAV는 fmt와 data 사이에 LIST 청크가 있을 수 있어 청크를 따라가며 찾는다.
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { EngineError } from './errors.ts'

export type WavInfo = {
  fmt: Buffer // fmt 청크 본문 (자른 파일에 그대로 쓴다)
  sampleRate: number
  blockAlign: number
  dataOffset: number
  dataSize: number
}

async function readAt(fh: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await fh.read(buf, 0, length, offset)
  return buf.subarray(0, bytesRead)
}

async function readInfo(fh: FileHandle, path: string): Promise<WavInfo> {
  const head = await readAt(fh, 0, 12)
  if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
    throw new EngineError('input', `WAV 파일이 아닙니다: ${path}`)
  }
  const { size } = await fh.stat()
  let fmt: Buffer | null = null
  let pos = 12
  while (pos + 8 <= size) {
    const h = await readAt(fh, pos, 8)
    const id = h.toString('ascii', 0, 4)
    const len = h.readUInt32LE(4)
    if (id === 'fmt ') fmt = await readAt(fh, pos + 8, len)
    if (id === 'data') {
      if (!fmt) break
      // 스트리밍으로 쓴 WAV는 data 크기가 비어 있거나 파일보다 클 수 있어 실제 크기로 자른다
      return {
        fmt,
        sampleRate: fmt.readUInt32LE(4),
        blockAlign: fmt.readUInt16LE(12),
        dataOffset: pos + 8,
        dataSize: Math.min(len, size - pos - 8)
      }
    }
    pos += 8 + len + (len % 2) // 청크는 짝수 바이트로 맞춘다
  }
  throw new EngineError('input', `WAV 형식을 읽을 수 없습니다: ${path}`)
}

export async function wavInfo(path: string): Promise<WavInfo> {
  const fh = await open(path, 'r')
  try {
    return await readInfo(fh, path)
  } finally {
    await fh.close()
  }
}

export async function wavDuration(path: string): Promise<number> {
  const info = await wavInfo(path)
  return info.dataSize / info.blockAlign / info.sampleRate
}

export function wavHeader(fmt: Buffer, dataSize: number): Buffer {
  const h = Buffer.alloc(12 + 8 + fmt.length + 8)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(h.length - 8 + dataSize, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(fmt.length, 16)
  fmt.copy(h, 20)
  h.write('data', 20 + fmt.length, 'ascii')
  h.writeUInt32LE(dataSize, 24 + fmt.length)
  return h
}

/** bounds(초)마다 새 WAV를 쓴다. 한 번에 수백 MB를 메모리에 올리지 않게 4MB씩 복사한다. */
export async function splitWav(src: string, bounds: [number, number][], outPaths: string[]): Promise<void> {
  const fh = await open(src, 'r')
  try {
    const info = await readInfo(fh, src)
    const totalFrames = Math.floor(info.dataSize / info.blockAlign)
    for (const [i, [start, end]] of bounds.entries()) {
      const first = Math.min(Math.round(start * info.sampleRate), totalFrames)
      const last = Math.min(Math.round(end * info.sampleRate), totalFrames)
      const bytes = (last - first) * info.blockAlign
      const out = await open(outPaths[i], 'w')
      try {
        await out.write(wavHeader(info.fmt, bytes))
        for (let done = 0; done < bytes; ) {
          const piece = await readAt(fh, info.dataOffset + first * info.blockAlign + done, Math.min(4 << 20, bytes - done))
          if (piece.length === 0) break
          await out.write(piece)
          done += piece.length
        }
      } finally {
        await out.close()
      }
    }
  } finally {
    await fh.close()
  }
}
