// ChatKHU 받아쓰기(stt-async-v5, Soniox) 어댑터. 조각(약 10분 WAV)마다 opus로 줄여 올리고, 끝날 때까지 상태를 물어 결과를 받는다.
// 올릴 때 오디오 1분에 6크레딧이 빠지고 실패해도 돌려주지 않아서, 올린 조각의 operation_id를 먼저 파일로 남겨
// 재시도·앱 재시작 때 다시 올리지 않고 이어서 결과만 받는다 (docs/decisions.md "ChatKHU 받아쓰기 시험").
import { existsSync } from 'node:fs'
import { readdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { EngineError } from '../errors.ts'
import { readJson, writeJsonAtomic } from '../files.ts'
import { runCapture } from '../proc.ts'
import type { Segment, SttEngine, TranscribeOptions } from './base.ts'

export const CHATKHU_STT_MODEL = 'stt-async-v5'
export const CHATKHU_STT_CREDITS_PER_MIN = 6

const UPLOAD_TIMEOUT_MS = 120_000
const POLL_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 3_000
const MAX_WAIT_MS = 30 * 60_000 // 조각 하나(약 10분)를 이보다 오래 기다리면 멈춘다

/** 조각 하나를 올린 기록 (<작업>/stt/<조각>.op.json) */
export type SttOperation = { operationId: string; credits: number; durationS: number }

type SonioxSegment = { speaker?: string; text?: string; start_ms?: number; end_ms?: number }
type SonioxResult = { status?: string; text?: string; segments?: SonioxSegment[]; error?: string }

export type ChatkhuSttOptions = {
  base: string // 게이트웨이 주소 (…/v1/gateway)
  apiKey: string
  ffmpeg: string
  /** 올린 기록(.op.json)과 임시 opus를 둘 폴더 */
  workDir: string
}

/** 90분 강의 크레딧처럼, 녹음 길이로 어림한 받아쓰기 크레딧 */
export function chatkhuSttCredits(durationS: number): number {
  return Math.round((durationS / 60) * CHATKHU_STT_CREDITS_PER_MIN)
}

function opPath(workDir: string, wav: string): string {
  return join(workDir, `${basename(wav)}.op.json`)
}

const OP_FILE_RE = /\.op\.json(\.failed-\d+)?$/

/** 이 작업에서 올린 조각들의 크레딧 합 (서버에서 실패해 다시 올린 조각도 크레딧이 빠졌으니 넣는다) */
export async function chargedCredits(workDir: string): Promise<number> {
  let sum = 0
  for (const name of await readdir(workDir).catch(() => [] as string[])) {
    if (OP_FILE_RE.test(name)) sum += (await readJson<SttOperation>(join(workDir, name))).credits
  }
  return Math.round(sum * 100) / 100
}

/**
 * 화자 차례마다 오는 구간은 몇 분짜리일 수 있어, 문장 끝에서 나누고 시각은 글자 위치로 나눠 붙인다(어림).
 * 문단 나누기(clean)가 구간 사이 간격과 길이로 문단을 만들기 때문이다.
 */
export function splitSegments(segments: SonioxSegment[]): Segment[] {
  const out: Segment[] = []
  for (const s of segments) {
    const text = (s.text ?? '').trim()
    if (!text) continue
    const start = s.start_ms ?? 0
    const end = Math.max(start, s.end_ms ?? start)
    const sentences = text.match(/[^.?!]+[.?!]*\s*/g) ?? [text]
    let at = 0
    for (const sentence of sentences) {
      const t = sentence.trim()
      const from = start + Math.round(((end - start) * at) / text.length)
      at += sentence.length
      const to = start + Math.round(((end - start) * at) / text.length)
      if (t) out.push({ startMs: from, endMs: to, text: t })
    }
  }
  return out
}

function signalFor(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs)
}

async function call(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: signalFor(timeoutMs, signal) })
  } catch (e) {
    if (signal?.aborted) throw new EngineError('cancelled', '작업을 취소했습니다.')
    if (e instanceof Error && e.name === 'TimeoutError') throw new EngineError('network', 'ChatKHU 받아쓰기 서버가 제때 답하지 않았어요. 다시 시도해 주세요.')
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name
    throw new EngineError('network', `ChatKHU 받아쓰기 서버에 연결하지 못했어요: ${cause}`)
  }
}

async function raise(resp: Response): Promise<never> {
  const body = (await resp.text()).slice(0, 300)
  if (resp.status === 401) throw new EngineError('auth', 'API 키가 올바르지 않아요. 설정에서 키를 확인해 주세요.')
  if (resp.status === 402) throw new EngineError('credits', '크레딧이 부족해 ChatKHU로 받아쓰지 못했어요.')
  if (resp.status === 403) throw new EngineError('auth', '이 키로는 ChatKHU 받아쓰기를 쓸 수 없어요.')
  if (resp.status === 429) throw new EngineError('rate_limit', '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.')
  if (resp.status >= 500) throw new EngineError('network', `ChatKHU 받아쓰기 서버 오류(${resp.status})예요. 잠시 후 다시 시도해 주세요.`)
  throw new EngineError('stt_failed', `ChatKHU 받아쓰기가 받지 않았어요 (${resp.status}): ${body}`)
}

export class ChatkhuStt implements SttEngine {
  private o: ChatkhuSttOptions

  constructor(o: ChatkhuSttOptions) {
    this.o = o
  }

  private get auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.o.apiKey}` }
  }

  async transcribe(wav: string, opts: TranscribeOptions): Promise<Segment[]> {
    const op = opPath(this.o.workDir, wav)
    let submitted = existsSync(op) ? await readJson<SttOperation>(op) : null
    if (!submitted) {
      submitted = await this.upload(wav, opts)
      await writeJsonAtomic(op, submitted)
    }
    try {
      return await this.wait(submitted, opts)
    } catch (e) {
      // 서버에서 실패한 조각은 다음 시도에 다시 올린다. 크레딧은 이미 빠졌으니 기록은 이름만 바꿔 남긴다
      if (e instanceof EngineError && e.code === 'stt_failed') await rename(op, `${op}.failed-${Date.now()}`)
      throw e
    }
  }

  private async upload(wav: string, opts: TranscribeOptions): Promise<SttOperation> {
    // 요청은 25MB까지라 10분 WAV(약 19MB, 마지막 조각은 더 길 수 있음)를 opus로 줄여 보낸다. webm은 받지 않는다
    const ogg = join(this.o.workDir, `${basename(wav)}.ogg`)
    const r = await runCapture(this.o.ffmpeg, ['-hide_banner', '-y', '-i', wav, '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', ogg], 'ffmpeg')
    if (r.code !== 0) throw new EngineError('ffmpeg', `ffmpeg 변환 실패:\n${r.stderr.slice(-2000)}`)
    try {
      const form = new FormData()
      form.append('file', new Blob([await readFile(ogg)], { type: 'audio/ogg' }), 'audio.ogg')
      form.append('model', CHATKHU_STT_MODEL)
      for (const lang of opts.language === 'en' ? ['en'] : ['ko', 'en']) form.append('language_hints', lang)
      // 화자가 바뀔 때마다 구간이 나뉘어 시각을 받을 수 있다 (끄면 조각 전체가 구간 하나로 온다)
      form.append('enable_speaker_diarization', 'true')
      const resp = await call(`${this.o.base}/audio/transcriptions/`, { method: 'POST', headers: this.auth, body: form }, UPLOAD_TIMEOUT_MS, opts.signal)
      if (!resp.ok) await raise(resp)
      const j = (await resp.json()) as { operation_id?: string; credits_charged?: number; duration_seconds?: number }
      if (!j.operation_id) throw new EngineError('stt_failed', 'ChatKHU 받아쓰기 응답에 작업 번호가 없어요.')
      return { operationId: j.operation_id, credits: j.credits_charged ?? 0, durationS: j.duration_seconds ?? 0 }
    } finally {
      await rm(ogg, { force: true })
    }
  }

  private async wait(op: SttOperation, opts: TranscribeOptions): Promise<Segment[]> {
    const url = `${this.o.base}/audio/transcriptions/${encodeURIComponent(op.operationId)}/`
    const started = Date.now()
    for (;;) {
      if (opts.signal?.aborted) throw new EngineError('cancelled', '작업을 취소했습니다.')
      const resp = await call(url, { headers: this.auth }, POLL_TIMEOUT_MS, opts.signal)
      if (!resp.ok) await raise(resp)
      const j = (await resp.json()) as SonioxResult
      if (j.status === 'completed') return splitSegments(j.segments?.length ? j.segments : [{ text: j.text ?? '', start_ms: 0, end_ms: op.durationS * 1000 }])
      if (j.status === 'failed') throw new EngineError('stt_failed', `ChatKHU 받아쓰기가 실패했어요: ${(j.error ?? '').slice(0, 300)} 이 조각의 크레딧은 이미 빠졌어요.`)
      if (Date.now() - started > MAX_WAIT_MS) throw new EngineError('network', 'ChatKHU 받아쓰기가 너무 오래 걸려요. 잠시 후 다시 시도해 주세요.')
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
  }
}
