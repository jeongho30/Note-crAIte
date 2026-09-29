// whisper.cpp(whisper-cli) 어댑터. pipeline/process_lecture.py의 transcribe()를 옮겨 온 것이다.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { constants, setPriority } from 'node:os'
import { dirname, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { EngineError } from '../errors.ts'
import { runCapture } from '../proc.ts'
import { defaultArgs } from '../sttargs.ts'
import type { Segment, SttEngine, TranscribeOptions } from './base.ts'

const PROGRESS_RE = /progress\s*=\s*(\d+)%/
const BACKEND_RE = /using (\S+) backend/
const TAIL_LINES = 40

type WhisperJson = { transcription?: { text?: string; offsets?: { from?: number; to?: number } }[] }

export async function parseWhisperJson(path: string): Promise<Segment[]> {
  const data = JSON.parse(await readFile(path, 'utf8')) as WhisperJson
  const segments: Segment[] = []
  for (const seg of data.transcription ?? []) {
    const text = (seg.text ?? '').trim()
    if (text) segments.push({ startMs: seg.offsets?.from ?? 0, endMs: seg.offsets?.to ?? 0, text })
  }
  return segments
}

/** gpu 설정이어도 쓸 GPU가 없으면 whisper는 CPU로 돈다. 로그(quiet: false)로 실제 백엔드를 확인한다. */
export function backendUsed(log: string[]): string {
  for (const line of log) {
    const m = BACKEND_RE.exec(line)
    if (m) return m[1]
  }
  return 'CPU'
}

function argPath(p: string, cwd: string): string {
  // whisper-cli는 인자를 ANSI 코드 페이지로 받는다. cwd 기준 상대 경로로 넘겨 사용자 이름 같은
  // 비ASCII 경로 조각을 피한다. 드라이브가 다르면 relative()가 절대 경로를 돌려준다.
  return relative(cwd, p) || '.'
}

export type WhisperOptions = {
  cli: string[] // 실행 명령 (테스트에서는 node + 가짜 스크립트)
  model: string
  vadModel: string | null
  threads: number
  gpuDevice: number | null // null이면 CPU만 쓴다
  quiet?: boolean // false면 -np 없이 돌려 백엔드 선택·처리 시간 로그를 lastLog에 남긴다
  beamSize?: number // 없으면 whisper-cli 기본(beam search). 1이면 greedy라 빠르지만 품질이 떨어질 수 있다
  args?: string[] | null // 설정 > 고급에서 고친 옵션. 있으면 threads·beamSize·gpuDevice·VAD 켜기 대신 쓴다
}

export class WhisperCpp implements SttEngine {
  opts: WhisperOptions
  lastLog: string[] = []

  constructor(opts: WhisperOptions) {
    this.opts = { quiet: true, ...opts }
  }

  command(wav: string, language: string): string[] {
    const cwd = dirname(wav)
    const o = this.opts
    const cmd = [...o.cli,
      '-m', argPath(o.model, cwd),
      '-f', argPath(wav, cwd),
      '-l', language,
      '-oj', '-of', argPath(wav, cwd), // 결과: <wav 이름>.json
      '-pp']
    if (o.quiet) cmd.push('-np')
    cmd.push(...(o.args ?? defaultArgs({ threads: o.threads, beamSize: o.beamSize, gpuDevice: o.gpuDevice, vad: o.vadModel !== null })))
    if (o.vadModel !== null) cmd.push('-vm', argPath(o.vadModel, cwd))
    return cmd
  }

  async transcribe(wav: string, { language, onProgress, signal }: TranscribeOptions): Promise<Segment[]> {
    const outJson = wav + '.json'
    await rm(outJson, { force: true })
    if (signal?.aborted) throw new EngineError('cancelled', '전사를 취소했습니다.')
    const [command, ...args] = this.command(wav, language)
    // -np여도 전사 구간은 stdout으로 나온다 (whisper.cpp examples/cli/cli.cpp). 읽지 않으면
    // 파이프가 가득 차 whisper가 멈추므로 버리고, 결과는 -oj JSON 파일에서 읽는다.
    const proc = spawn(command, args, { cwd: dirname(wav), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    try {
      // 낮은 우선순위로 돌려 PC 사용을 덜 방해한다.
      if (proc.pid !== undefined) setPriority(proc.pid, constants.priority.PRIORITY_BELOW_NORMAL)
    } catch {
      // 우선순위를 못 바꿔도 전사는 계속한다
    }
    const kill = (): void => {
      proc.kill()
    }
    signal?.addEventListener('abort', kill, { once: true })

    const tail: string[] = []
    // 로그를 켜면 VAD가 구간마다 줄을 남겨 앞쪽의 백엔드 선택 줄이 밀려나므로 전부 보관한다.
    const log: string[] | null = this.opts.quiet ? null : []
    createInterface({ input: proc.stderr }).on('line', (raw) => {
      const line = raw.trimEnd()
      const m = PROGRESS_RE.exec(line)
      if (m) {
        onProgress?.(Number(m[1]) / 100)
      } else if (line) {
        tail.push(line)
        if (tail.length > TAIL_LINES) tail.shift()
        log?.push(line)
      }
    })
    const code = await new Promise<number | null>((resolve, reject) => {
      proc.on('error', (e) => reject(new EngineError('stt_failed', `whisper-cli 실행 실패: ${e.message}`)))
      proc.on('close', resolve)
    }).finally(() => signal?.removeEventListener('abort', kill))

    this.lastLog = log ?? tail
    if (signal?.aborted) throw new EngineError('cancelled', '전사를 취소했습니다.')
    if (code !== 0) throw new EngineError('stt_failed', 'whisper-cli 실행 실패:\n' + tail.join('\n'))
    if (!existsSync(outJson)) throw new EngineError('stt_failed', `whisper JSON 출력을 찾을 수 없습니다: ${outJson}`)
    return parseWhisperJson(outJson)
  }
}

/**
 * 고친 옵션을 whisper-cli가 받아들이는지 빨리 본다. 없는 입력 파일로 실행하면 옵션을 다 읽은 뒤 파일을 찾다가
 * 바로 끝나므로, 그 오류가 나오면 옵션은 괜찮다. 아니면 whisper-cli가 말한 이유를 돌려준다.
 */
export async function checkArgs(cli: string[], args: string[]): Promise<string | null> {
  const [command, ...pre] = cli
  const r = await runCapture(command, [...pre, ...args, '-f', 'lecture-notes-missing.wav'], 'stt_failed', true)
  const lines = `${r.stdout}\n${r.stderr}`.split(/\r?\n/)
  if (lines.some((l) => l.includes('input file not found'))) return null
  return lines.find((l) => l.startsWith('error:'))?.replace(/^error:\s*/, '') ?? '옵션을 읽지 못했어요'
}
