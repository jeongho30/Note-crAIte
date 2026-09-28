// 작업 폴더 파일을 원자적으로 쓰고 읽는다 (쓰다 만 파일이 재개 판정을 속이지 않게).
import { readFile, rename, writeFile } from 'node:fs/promises'

export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify(data), 'utf8')
  await rename(tmp, path)
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}
