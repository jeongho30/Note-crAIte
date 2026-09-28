// 저장 폴더 검사: 쓸 수 있는지, 옵시디언 볼트 안인지, 이미 있는 과목 폴더.
import { existsSync, statSync } from 'node:fs'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type FolderInfo = {
  path: string
  exists: boolean
  /** 없는 폴더는 가장 가까운 상위 폴더에 만들 수 있는지로 본다 */
  writable: boolean
  /** 이 폴더나 상위 폴더에 .obsidian이 있으면 그 볼트 폴더 */
  vaultRoot: string | null
  /** 하위 폴더 이름 = 과목 목록 (숨김 폴더 제외) */
  subjects: string[]
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function findVaultRoot(path: string): string | null {
  for (let dir = path; ; dir = dirname(dir)) {
    if (isDir(join(dir, '.obsidian'))) return dir
    if (dirname(dir) === dir) return null
  }
}

function nearestExisting(path: string): string {
  let dir = path
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir)
  return dir
}

// Windows에서는 fs.access의 쓰기 검사가 읽기 전용 속성만 봐서, 실제로 파일을 만들어 본다.
async function canWrite(dir: string): Promise<boolean> {
  const probe = join(dir, `.lecture-notes-${process.pid}-${Date.now()}.tmp`)
  try {
    await writeFile(probe, '')
    await unlink(probe)
    return true
  } catch {
    return false
  }
}

export async function inspectFolder(path: string): Promise<FolderInfo> {
  const exists = isDir(path)
  const subjects = exists
    ? (await readdir(path, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b, 'ko'))
    : []
  return { path, exists, writable: await canWrite(nearestExisting(path)), vaultRoot: findVaultRoot(nearestExisting(path)), subjects }
}

/** 저장 폴더로 정한다: 없으면 만들고 다시 검사한다. */
export async function useFolder(path: string): Promise<FolderInfo> {
  await mkdir(path, { recursive: true })
  return inspectFolder(path)
}
