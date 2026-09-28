// 데이터 폴더와 외부 실행 파일(ffmpeg, whisper-cli)의 위치.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { EngineError } from './errors.ts'

export const APP_NAME = 'lecture-notes'
export const EXE = process.platform === 'win32' ? '.exe' : ''

export function defaultDataDir(): string {
  // 모델이 수 GB라 Windows에서는 Roaming이 아닌 Local에 둔다.
  if (process.platform === 'win32') return join(process.env['LOCALAPPDATA']!, APP_NAME)
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', APP_NAME)
  return join(homedir(), '.local', 'share', APP_NAME)
}

function which(name: string): string | null {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name)
  }
  return null
}

/** binDir(설치본의 resources/bin)에 없으면 PATH에서 찾는다. */
export function findFfmpeg(binDir?: string): string {
  if (binDir && existsSync(join(binDir, `ffmpeg${EXE}`))) return join(binDir, `ffmpeg${EXE}`)
  const found = which(`ffmpeg${EXE}`)
  if (found) return found
  throw new EngineError('ffmpeg', 'ffmpeg를 찾을 수 없습니다.')
}

/** dirs를 순서대로 본다. 설치본은 resources/bin/whisper, 개발 중에는 저장소의 .cache/whisper/bin. */
export function findWhisperCli(dirs: string[]): string {
  for (const dir of dirs) {
    const cli = join(dir, `whisper-cli${EXE}`)
    if (existsSync(cli)) return cli
  }
  throw new EngineError('stt_failed', 'whisper-cli를 찾을 수 없습니다: ' + dirs.join(', '))
}
