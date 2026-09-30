// 자동 처리(폴더 감시): 감시 폴더의 녹음을 찾아, 복사·동기화가 끝난 것만 작업으로 넘긴다.
// 이벤트(fs.watch) 대신 폴링한다: 클라우드 동기화 폴더에서 변경 이벤트가 빠질 수 있다 (9/28 결정).
// 감시 폴더 바로 아래는 미분류, 하위 폴더 이름이 과목이다. 처리한 녹음은 그 폴더의 "처리됨"으로 옮긴다.
import { createHash } from 'node:crypto'
import { mkdir, open, readdir, rename, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { readJson, writeJsonAtomic } from './files.ts'
import { AUDIO_EXTS, findNotes } from './inputs.ts'

export const DONE_DIR = '처리됨'
/** 마지막으로 바뀐 뒤 이만큼 지나야 복사가 끝난 것으로 본다 */
export const MIN_AGE_MS = 60_000

export type WatchFile = { path: string; subject: string | null; size: number; mtimeMs: number }

const isAudio = (name: string): boolean => AUDIO_EXTS.includes(extname(name).slice(1).toLowerCase())
// 숨김·임시 파일 (Office 잠금 파일 ~$, 점으로 시작하는 동기화 임시 파일)
const isHidden = (name: string): boolean => name.startsWith('.') || name.startsWith('~$')

async function audioIn(dir: string, subject: string | null): Promise<WatchFile[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: WatchFile[] = []
  for (const e of entries) {
    if (!e.isFile() || isHidden(e.name) || !isAudio(e.name)) continue
    const path = join(dir, e.name)
    try {
      const s = await stat(path)
      out.push({ path, subject, size: s.size, mtimeMs: s.mtimeMs })
    } catch {
      // 그사이 지워지거나 옮겨짐
    }
  }
  return out
}

/** 감시 폴더 바로 아래(미분류)와 과목 폴더 한 단계 아래의 녹음. "처리됨"과 숨김 폴더는 보지 않는다. */
export async function scanWatchFolder(root: string): Promise<WatchFile[]> {
  const files = await audioIn(root, null)
  let dirs
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && !isHidden(e.name) && e.name !== DONE_DIR)
  } catch {
    return files
  }
  for (const d of dirs) files.push(...(await audioIn(join(root, d.name), d.name)))
  return files
}

/** 과목 폴더 이름 (감시 폴더를 켤 때 저장 폴더의 과목을 만들어 줄지 묻는다) */
export async function subjectDirs(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !isHidden(e.name) && e.name !== DONE_DIR)
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** 같은 녹음인지 가리는 값: 크기 + 앞뒤 1MB의 sha256 (파일 이름·위치가 바뀌어도 같다). */
export async function fingerprint(path: string, size: number): Promise<string> {
  const h = createHash('sha256').update(String(size))
  const f = await open(path, 'r')
  try {
    const n = Math.min(size, 1 << 20)
    const buf = Buffer.alloc(n)
    await f.read(buf, 0, n, 0)
    h.update(buf)
    if (size > n) {
      await f.read(buf, 0, n, size - n)
      h.update(buf)
    }
  } finally {
    await f.close()
  }
  return h.digest('hex').slice(0, 32)
}

/** 다른 프로그램이 쓰고 있어 열 수 없으면 false (복사·녹음 중). 읽기 전용 파일은 쓰기로 못 열어도 true. */
export async function canOpen(path: string): Promise<boolean> {
  try {
    const f = await open(path, 'r+')
    await f.close()
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') {
      try {
        return ((await stat(path)).mode & 0o200) === 0 // 읽기 전용이라 못 연 것
      } catch {
        return false
      }
    }
    return false
  }
}

// ── 처리 기록 (<데이터 폴더>/watch.json) ──

export type WatchState = {
  /** 처리하려고 넘긴 녹음 (fingerprint → 기록). 다시 넘기지 않는다 */
  seen: Record<string, { path: string; at: string; jobId: string | null }>
  /** 켤 때 [새 녹음만]을 고른 경우 그때 있던 파일 (경로|크기|수정 시각). 파일을 읽지 않고 거른다 */
  baseline: string[]
}

const statePath = (dataDir: string): string => join(dataDir, 'watch.json')

export async function loadWatchState(dataDir: string): Promise<WatchState> {
  try {
    return { seen: {}, baseline: [], ...(await readJson<Partial<WatchState>>(statePath(dataDir))) }
  } catch {
    return { seen: {}, baseline: [] }
  }
}

export function saveWatchState(dataDir: string, s: WatchState): Promise<void> {
  return writeJsonAtomic(statePath(dataDir), s)
}

export const baselineKey = (f: WatchFile): string => `${f.path}|${f.size}|${Math.round(f.mtimeMs)}`

/**
 * 복사·동기화가 끝나 처리해도 되는 파일만 고른다: 마지막으로 바뀐 지 MIN_AGE_MS가 지났고,
 * 앞 폴링 때와 크기·수정 시각이 같다. (파일을 열어 보는 잠금 확인과 기록 확인은 부르는 쪽에서)
 */
export function settled(files: WatchFile[], previous: Map<string, WatchFile>, now: number): WatchFile[] {
  return files.filter((f) => {
    const p = previous.get(f.path)
    return !!p && p.size === f.size && p.mtimeMs === f.mtimeMs && now - f.mtimeMs >= MIN_AGE_MS && f.size > 0
  })
}

/** 비어 있는 이름을 찾는다: "이름.m4a"가 있으면 "이름 (2).m4a" */
async function freePath(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 1; ; i++) {
    const p = join(dir, i === 1 ? name : `${stem} (${i})${ext}`)
    try {
      await stat(p)
    } catch {
      return p
    }
  }
}

/** 처리한 녹음과 같은 이름의 필기를 그 폴더의 "처리됨"으로 옮긴다. 옮긴 녹음 경로를 돌려준다(못 옮기면 throw). */
export async function moveToDone(audio: string): Promise<{ audio: string; notes: string | null }> {
  const dir = join(audio, '..', DONE_DIR)
  await mkdir(dir, { recursive: true })
  const notes = findNotes(audio)
  const target = await freePath(dir, basename(audio))
  await rename(audio, target)
  let movedNotes: string | null = null
  if (notes) {
    // 필기 이름은 옮긴 녹음과 짝이 맞게 ("이름 (2).m4a"면 "이름 (2).md")
    const stem = basename(target).slice(0, basename(target).length - extname(target).length)
    movedNotes = await freePath(dir, stem + extname(notes))
    try {
      await rename(notes, movedNotes)
    } catch {
      movedNotes = null
    }
  }
  return { audio: target, notes: movedNotes }
}
