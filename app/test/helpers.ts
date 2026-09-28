// 테스트 공통: 임시 폴더와 합성 WAV (저장소에 실제 녹음을 두지 않는다).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { wavHeader } from '../src/core/wav.ts'

/** 테스트 파일이 끝나면 지워지는 임시 폴더. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ln-test-'))
  after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 16비트 모노 무음 WAV. */
export async function writeWav(path: string, seconds: number, rate = 16000): Promise<void> {
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0) // PCM
  fmt.writeUInt16LE(1, 2) // 모노
  fmt.writeUInt32LE(rate, 4)
  fmt.writeUInt32LE(rate * 2, 8)
  fmt.writeUInt16LE(2, 12)
  fmt.writeUInt16LE(16, 14)
  const data = Buffer.alloc(Math.round(seconds * rate) * 2)
  await writeFile(path, Buffer.concat([wavHeader(fmt, data.length), data]))
}
