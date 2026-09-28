// 작업 폴더 파일을 원자적으로 쓰고 읽는다 (쓰다 만 파일이 재개 판정을 속이지 않게).
import { randomBytes } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

const RENAME_RETRIES = 5

export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  // 임시 파일 이름을 쓸 때마다 다르게 해서, 같은 파일을 동시에 써도 서로의 임시 파일을 덮지 않게 한다.
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(data), 'utf8')
  // Windows에서는 백신·검색 색인이 대상 파일을 잠깐 열고 있으면 rename이 EPERM/EBUSY로 실패한다. 잠시 뒤 다시 한다.
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, path)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i < RENAME_RETRIES && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await new Promise((r) => setTimeout(r, 50 * (i + 1)))
        continue
      }
      await unlink(tmp).catch(() => {})
      throw e
    }
  }
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}
