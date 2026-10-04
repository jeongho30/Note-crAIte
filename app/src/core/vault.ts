// 저장 폴더 검사: 쓸 수 있는지, 옵시디언 볼트 안인지, 이미 있는 과목 폴더.
import { existsSync, statSync } from 'node:fs'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { EngineError } from './errors.ts'
import { diskName } from './files.ts'

export type FolderInfo = {
  path: string
  exists: boolean
  /** 아직 없는 폴더는 null: 미리 판단하지 않고 useFolder로 만들 때 확인한다 */
  writable: boolean | null
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
        .map((d) => diskName(d.name))
        .sort((a, b) => a.localeCompare(b, 'ko'))
    : []
  return { path, exists, writable: exists ? await canWrite(path) : null, vaultRoot: findVaultRoot(nearestExisting(path)), subjects }
}

/** 저장 폴더로 정한다: 없으면 만들고, 실제로 쓸 수 있는지 확인한다. */
export async function useFolder(path: string): Promise<FolderInfo> {
  try {
    await mkdir(path, { recursive: true })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? (e as Error).name
    throw new EngineError('input', `폴더를 만들지 못했어요(${code}). 다른 폴더를 골라 주세요.`)
  }
  const info = await inspectFolder(path)
  if (!info.writable) throw new EngineError('input', '이 폴더에는 저장할 수 없어요. 다른 폴더를 골라 주세요.')
  return info
}
