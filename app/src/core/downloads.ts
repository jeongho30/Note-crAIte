// 모델 파일 다운로드: .part 이어받기(HTTP Range), 크기·sha256 확인 후 제자리에 옮긴다.
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, open, rename, stat, statfs, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { EngineError } from './errors.ts'
import { MODELS } from './models.ts'

export type Progress = (done: number, total: number) => void

export async function sha256Of(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const block of createReadStream(path)) h.update(block as Buffer)
  return h.digest('hex')
}

async function sizeOf(path: string): Promise<number> {
  return existsSync(path) ? (await stat(path)).size : 0
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

export async function download(url: string, dest: string, size: number, sha256: string,
                               onProgress?: Progress, signal?: AbortSignal): Promise<string> {
  // 완성본은 검증을 통과한 .part를 옮긴 것뿐이라, 매번 수 GB를 다시 해시하지 않고 크기만 본다.
  if ((await sizeOf(dest)) === size) return dest

  await mkdir(dirname(dest), { recursive: true })
  const part = dest + '.part'
  let have = await sizeOf(part)
  if (have > size) {
    await unlink(part)
    have = 0
  }

  if (have < size) {
    const fs = await statfs(dirname(dest))
    if (fs.bavail * fs.bsize < size - have) {
      throw new EngineError('disk', `디스크 공간이 부족합니다 (${((size - have) / 1e9).toFixed(1)}GB 필요).`)
    }
    try {
      const resp = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal })
      if (resp.status === 200) have = 0 // 서버가 Range를 무시하면 처음부터 받는다
      else if (resp.status !== 206) throw new EngineError('download', `다운로드 실패 (${resp.status}): ${url}`)
      const out = await open(part, have ? 'a' : 'w')
      try {
        for await (const chunk of resp.body!) {
          await out.write(chunk)
          have += chunk.length
          onProgress?.(have, size)
        }
      } finally {
        await out.close()
      }
    } catch (e) {
      if (e instanceof EngineError) throw e
      if (isAbort(e)) throw new EngineError('cancelled', '다운로드를 취소했습니다.')
      const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message
      throw new EngineError('network', `다운로드 중 네트워크 오류가 났습니다. 다시 시도하면 이어서 받습니다: ${cause}`)
    }
  }

  if ((await sizeOf(part)) !== size || (await sha256Of(part)) !== sha256) {
    await unlink(part)
    throw new EngineError('download', `받은 파일이 손상됐습니다. 다시 받아 주세요: ${dest}`)
  }
  await rename(part, dest)
  return dest
}

export async function ensureModel(kind: 'whisper' | 'vad', name: string, modelsDir: string,
                                  onProgress?: Progress, signal?: AbortSignal): Promise<string> {
  const e = MODELS[kind][name]
  if (!e) throw new EngineError('input', `모르는 모델입니다: ${name}`)
  return download(e.url, join(modelsDir, e.file), e.size, e.sha256, onProgress, signal)
}
