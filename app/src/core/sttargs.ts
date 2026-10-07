// 받아쓰기 세부설정: whisper-cli 명령 중 사용자가 고칠 수 있는 옵션.
// 파일·모델·언어·출력 형식은 앱이 정하고(잠금), 나머지(스레드, 반복 억제, 탐색 폭, 장치, VAD 등)만 고칠 수 있다.
import { sep } from 'node:path'
import { EngineError } from './errors.ts'

/** 앱이 정하는 옵션. 사용자 옵션에 들어 있으면 거절한다. */
const LOCKED = new Set([
  '-m', '--model', '-f', '--file', '-l', '--language', '-of', '--output-file', '-pp', '--print-progress', '-np', '--no-prints',
  '-vm', '--vad-model', '-otxt', '--output-txt', '-ovtt', '--output-vtt', '-osrt', '--output-srt', '-olrc', '--output-lrc',
  '-owts', '--output-words', '-ocsv', '--output-csv', '-oj', '--output-json', '-ojf', '--output-json-full', '-h', '--help'
])

export type TunableOptions = { threads: number; beamSize?: number; gpuDevice: number | null; vad: boolean }

/** 앱 기본 옵션: 스레드, 반복 억제 끔(-mc 0), 탐색 폭, 장치, VAD. */
export function defaultArgs(o: TunableOptions): string[] {
  return [
    '-t', String(o.threads),
    // 긴 강의에서 같은 문장을 반복 출력하며 내용을 통째로 날리는 루프를 막는다 (VAD와 함께).
    '-mc', '0',
    ...(o.beamSize !== undefined ? ['-bs', String(o.beamSize)] : []),
    ...(o.gpuDevice === null ? ['-ng'] : ['-dev', String(o.gpuDevice)]),
    ...(o.vad ? ['--vad'] : [])
  ]
}

/** 사용자가 입력한 옵션 문자열을 나눈다. 잠긴 옵션이나 따옴표·경로가 있으면 이유와 함께 거절한다. */
export function parseArgs(text: string): string[] {
  const args = text.trim().split(/\s+/).filter(Boolean)
  for (const a of args) {
    if (/["'`]/.test(a)) throw new EngineError('input', '옵션에는 따옴표를 쓸 수 없어요.')
    if (/[\\/]/.test(a)) throw new EngineError('input', '옵션에는 경로를 넣을 수 없어요. 파일과 모델은 앱이 정해요.')
    const flag = a.split('=')[0]
    if (LOCKED.has(flag)) throw new EngineError('input', `${flag}는 앱이 정하는 옵션이라 바꿀 수 없어요.`)
  }
  return args
}

/** 설정 화면에 보여 줄 명령: 잠긴 부분과 고칠 수 있는 부분. WhisperCpp.command와 같은 순서다. 경로 구분 글자는 OS를 따른다 */
export function previewCommand(modelFile: string, vadFile: string | null, language: string, args: string[], pathSep = sep): { locked: string; editable: string } {
  const locked = ['whisper-cli', '-m', `models${pathSep}${modelFile}`, '-f', 'part_000.wav', '-l', language, '-oj', '-of', 'part_000.wav', '-pp', '-np']
  if (vadFile) locked.push('-vm', `models${pathSep}${vadFile}`)
  return { locked: locked.join(' '), editable: args.join(' ') }
}
