// 작업 폴더 파일을 원자적으로 쓰고 읽는다 (쓰다 만 파일이 재개 판정을 속이지 않게).
import { randomBytes } from 'node:crypto'
import { readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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

/** 폴더 안 파일 크기의 합 (하위 폴더 포함). 없으면 0. */
export async function dirSize(dir: string): Promise<number> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const e of entries) {
    const path = join(dir, e.name)
    if (e.isDirectory()) total += await dirSize(path)
    else if (e.isFile()) total += await stat(path).then((s) => s.size, () => 0)
  }
  return total
}
