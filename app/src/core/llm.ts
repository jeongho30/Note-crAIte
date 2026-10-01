// OpenAI 호환 chat completions 호출. pipeline/process_lecture.py의 generate_note() 호출부를 옮겨 온 것이다.
// API 키는 요청 헤더에만 쓰고 로그·예외 메시지에 넣지 않는다.
import { EngineError } from './errors.ts'
import * as ollama from './ollama.ts'
import type { OllamaRequest } from './ollama.ts'

const TIMEOUT_MESSAGE =
  '요약 모델이 제때 답하지 않아 연결이 끊겼어요. 크레딧은 이미 빠졌을 수 있어요. 설정에서 더 빠른 요약 모델로 바꾼 뒤 다시 시도해 주세요.'

const STATUS_ERRORS: Record<number, [string, string]> = {
  401: ['auth', 'API 키가 올바르지 않아요. 설정에서 키를 확인해 주세요.'],
  403: ['auth', 'API 키에 이 기능을 쓸 권한이 없어요.'],
  402: ['credits', '크레딧이 부족해요.'],
  413: ['too_large', '전사문이 너무 길어 요약 서버가 받지 않았어요.'],
  429: ['rate_limit', '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.'],
  // 게이트웨이(Cloudflare)가 모델의 답을 오래 기다리다 끊은 것. 모델은 끝까지 답을 만들어 크레딧이 빠진다(요약 모델 비교 2차)
  504: ['timeout', TIMEOUT_MESSAGE],
  524: ['timeout', TIMEOUT_MESSAGE]
}

export type Message = { role: 'system' | 'user' | 'assistant'; content: string }
export type Usage = { prompt_tokens?: number; completion_tokens?: number; [k: string]: unknown }

export async function raiseForStatus(resp: Response, what: string): Promise<void> {
  if (resp.status === 200) return
  const known = STATUS_ERRORS[resp.status]
  if (known) throw new EngineError(known[0], known[1])
  if (resp.status >= 500) throw new EngineError('network', `${what} 서버 오류(${resp.status})예요. 잠시 후 다시 시도해 주세요.`)
  throw new EngineError('llm', `${what} 오류 (${resp.status}): ${(await resp.text()).slice(0, 500)}`)
}

export function headers(apiKey: string | null): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) h['Authorization'] = `Bearer ${apiKey}`
  return h
}

/** 연결 실패·시간 초과를 사용자용 메시지로 바꾼다. 원래 오류 메시지에는 URL이 들어갈 수 있어 이름만 쓴다. */
export async function request(url: string, init: RequestInit, timeoutMs: number, what: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      throw new EngineError('network', `${what} 서버가 제때 답하지 않았어요. 다시 시도해 주세요.`)
    }
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name
    throw new EngineError('network', `${what} 서버에 연결하지 못했어요: ${cause}`)
  }
}

export type ChatOptions = {
  maxTokens?: number
  responseFormat?: object
  timeoutMs?: number
  /** 있으면 로컬 LLM(Ollama)으로 보낸다: 고친 요청 옵션. 아래 둘은 로컬에서만 쓰인다 */
  ollama?: OllamaRequest
  signal?: AbortSignal
  /** 이 호출 뒤 모델을 메모리에서 내린다 */
  unloadAfter?: boolean
}

type StreamChunk = { choices?: { delta?: { content?: string | null } }[]; usage?: Usage | null; error?: { message?: string } }

/** SSE(`data: {...}` 줄)로 온 답을 이어 붙인다. usage는 마지막 조각에 온다(stream_options.include_usage). */
async function readStream(resp: Response): Promise<[string, Usage | null]> {
  const reader = resp.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  let usage: Usage | null = null
  const handle = (line: string): void => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    const chunk = JSON.parse(data) as StreamChunk
    if (chunk.error) throw new EngineError('llm', `요약 오류: ${String(chunk.error.message ?? '').slice(0, 500)}`)
    content += chunk.choices?.[0]?.delta?.content ?? ''
    if (chunk.usage) usage = chunk.usage
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      handle(buf.slice(0, i).trim())
      buf = buf.slice(i + 1)
    }
  }
  handle(buf.trim())
  return [content, usage]
}

/**
 * [응답 본문, usage]를 돌려준다. 스트리밍으로 받는다: 추론이 긴 모델도 조각이 계속 와서
 * 게이트웨이가 약 100초에 끊지(524) 않는다(9/30 qwen3.7-plus 110·142초 확인). 서버가 스트리밍을 무시하면 한 번에 받은 JSON을 읽는다.
 */
export async function chat(endpoint: string, apiKey: string | null, model: string, messages: Message[],
                           { maxTokens = 8192, responseFormat, timeoutMs = 300_000, ollama: local, signal, unloadAfter }: ChatOptions = {}): Promise<[string, Usage | null]> {
  if (local) {
    // 로컬은 json_schema 봉투 없이 스키마만 받는다
    const format = (responseFormat as { json_schema?: { schema?: object } } | undefined)?.json_schema?.schema
    return ollama.chat(endpoint, model, messages, { request: local, maxTokens, format, signal, unloadAfter })
  }
  const body: Record<string, unknown> = { model, messages, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } }
  if (responseFormat) body['response_format'] = responseFormat
  const resp = await request(endpoint, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body) }, timeoutMs, '요약')
  await raiseForStatus(resp, '요약')
  let text: string
  let usage: Usage | null
  try {
    if ((resp.headers.get('content-type') ?? '').includes('text/event-stream')) {
      ;[text, usage] = await readStream(resp)
    } else {
      const data = (await resp.json()) as { choices: { message: { content?: string | null } }[]; usage?: Usage }
      ;[text, usage] = [data.choices[0].message.content ?? '', data.usage ?? null]
    }
  } catch (e) {
    if (e instanceof EngineError) throw e
    if (e instanceof Error && e.name === 'TimeoutError') throw new EngineError('timeout', TIMEOUT_MESSAGE)
    throw new EngineError('network', '요약 답을 받다가 연결이 끊겼어요. 다시 시도해 주세요.')
  }
  const content = text.trim()
  // 추론 모델은 max_tokens 안에서 생각하다 본문 없이 끝날 수 있다 (ChatKHU 문서)
  if (!content) throw new EngineError('llm', '요약 모델이 빈 응답을 돌려줬어요.')
  return [content, usage]
}
