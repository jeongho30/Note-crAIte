// 외부 실행 파일(ffmpeg 등)을 창 없이 돌리고 출력을 모은다.
import { spawn } from 'node:child_process'
import { EngineError } from './errors.ts'

export type RunResult = { code: number | null; stdout: string; stderr: string }

/**
 * captureStdout이 false면 stdout은 버린다 (많이 찍는 프로그램을 읽지 않으면 파이프가 차서 멈출 수 있음).
 * 실행 파일을 못 찾으면 errorCode로 실패한다.
 */
export function runCapture(command: string, args: string[], errorCode: string, captureStdout = false): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { windowsHide: true, stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    proc.stdout?.on('data', (b: Buffer) => out.push(b))
    proc.stderr?.on('data', (b: Buffer) => err.push(b))
    proc.on('error', (e) => reject(new EngineError(errorCode, `${command} 실행 실패: ${e.message}`)))
    proc.on('close', (code) =>
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    )
  })
}
