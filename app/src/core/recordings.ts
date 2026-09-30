// 앱에서 한 녹음 (<데이터 폴더>/recordings).
// 녹음하는 동안에는 `<이름>.recording.webm`에 조각을 덧붙여 쓰고(앱이 죽어도 그 직전까지 남게),
// 끝나면 ffmpeg로 길이 정보를 넣어(MediaRecorder의 webm에는 길이가 없어 되감기가 안 됨) `<이름>.webm`으로 옮긴다.
// 작업으로 넘긴 녹음은 processed.json에 적어 둔다. 완료한 작업 기록을 지워도 "처리하지 않은 녹음"으로 다시 뜨지 않게.
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { readJson, writeJsonAtomic } from './files.ts'
import { runCapture } from './proc.ts'

export const RECORDING_SUFFIX = '.recording.webm'
const DONE_SUFFIX = '.webm'

export type RecordingFile = { path: string; name: string; bytes: number; modifiedAt: string }

export function recordingsDir(dataDir: string): string {
  return join(dataDir, 'recordings')
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** "녹음 2026-09-30 14.05" (파일 이름에 쓸 수 없는 콜론 대신 점) */
export function recordingName(d: Date): string {
  return `녹음 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`
}

/** 녹음 중 파일 → 끝난 파일 이름 (확장자 바꾸기가 아니라 고정 접미사를 뗀다) */
export function finishedPath(temp: string): string {
  return temp.slice(0, temp.length - RECORDING_SUFFIX.length) + DONE_SUFFIX
}

/** 새 녹음 파일 경로. 같은 분에 또 녹음하면 " (2)"를 붙인다 */
export async function newRecordingPath(dataDir: string, now = new Date()): Promise<string> {
  const dir = recordingsDir(dataDir)
  await mkdir(dir, { recursive: true })
  const base = recordingName(now)
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base} (${i})`
    const temp = join(dir, name + RECORDING_SUFFIX)
    if (!existsSync(temp) && !existsSync(join(dir, name + DONE_SUFFIX))) return temp
  }
}

/**
 * 녹음 중 파일을 끝난 녹음으로 만든다. 길이 정보를 넣지 못하면(ffmpeg 실패) 그대로 이름만 바꾼다.
 * 빈 파일이면 지우고 null.
 */
export async function finishRecording(ffmpeg: string, temp: string, startedAt: Date): Promise<string | null> {
  const size = await stat(temp).then((s) => s.size, () => 0)
  if (size === 0) {
    await unlink(temp).catch(() => {})
    return null
  }
  const out = finishedPath(temp)
  // -metadata creation_time: 노트의 날짜가 녹음을 시작한 날이 되게
  const args = ['-hide_banner', '-y', '-i', temp, '-c', 'copy', '-metadata', `creation_time=${startedAt.toISOString()}`, out]
  const ok = await runCapture(ffmpeg, args, 'ffmpeg').then((r) => r.code === 0, () => false)
  if (ok && (await stat(out).then((s) => s.size > 0, () => false))) {
    await unlink(temp).catch(() => {})
  } else {
    await unlink(out).catch(() => {})
    await rename(temp, out)
  }
  return out
}

/** 앱이 죽거나 꺼져 녹음 중 파일로 남은 것을 끝난 녹음으로 만든다 (지금 녹음 중인 파일은 빼고) */
export async function repairRecordings(ffmpeg: string, dataDir: string, active: string | null): Promise<void> {
  const dir = recordingsDir(dataDir)
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    if (!name.endsWith(RECORDING_SUFFIX)) continue
    const temp = join(dir, name)
    if (active && samePath(active, temp)) continue
    const started = await stat(temp).then((s) => s.birthtime, () => new Date())
    await finishRecording(ffmpeg, temp, started)
  }
}

/** 끝난 녹음 목록 (오래된 것부터) */
export async function listRecordings(dataDir: string): Promise<RecordingFile[]> {
  const dir = recordingsDir(dataDir)
  const names = await readdir(dir).catch(() => [] as string[])
  const out: RecordingFile[] = []
  for (const name of names) {
    if (!name.endsWith(DONE_SUFFIX) || name.endsWith(RECORDING_SUFFIX)) continue
    const s = await stat(join(dir, name)).catch(() => null)
    if (s?.isFile()) out.push({ path: join(dir, name), name, bytes: s.size, modifiedAt: s.mtime.toISOString() })
  }
  return out.sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt))
}

/** 녹음 폴더 안의 끝난 녹음인가 (화면이 넘긴 경로를 지우기 전에 확인) */
export function isRecording(dataDir: string, path: string): boolean {
  return samePath(dirname(path), recordingsDir(dataDir)) && path.endsWith(DONE_SUFFIX) && !path.endsWith(RECORDING_SUFFIX)
}

function processedPath(dataDir: string): string {
  return join(recordingsDir(dataDir), 'processed.json')
}

async function loadProcessed(dataDir: string): Promise<string[]> {
  return readJson<{ names: string[] }>(processedPath(dataDir)).then((p) => p.names, () => [])
}

/** 작업으로 넘긴 녹음을 적는다. 녹음 폴더 밖의 파일은 무시한다 */
export async function markProcessed(dataDir: string, paths: string[]): Promise<void> {
  const names = paths.filter((p) => isRecording(dataDir, p)).map((p) => basename(p))
  if (!names.length) return
  const next = [...new Set([...(await loadProcessed(dataDir)), ...names])]
  await writeJsonAtomic(processedPath(dataDir), { names: next })
}

/** 지운 녹음을 처리 기록에서도 뺀다 */
export async function forgetProcessed(dataDir: string, paths: string[]): Promise<void> {
  const gone = new Set(paths.map((p) => basename(p)))
  const names = await loadProcessed(dataDir)
  if (!names.some((n) => gone.has(n))) return
  await writeJsonAtomic(processedPath(dataDir), { names: names.filter((n) => !gone.has(n)) })
}

/** 아직 작업으로 넘기지 않은 녹음 */
export async function unprocessedRecordings(dataDir: string): Promise<RecordingFile[]> {
  const processed = new Set(await loadProcessed(dataDir))
  return (await listRecordings(dataDir)).filter((r) => !processed.has(r.name))
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
