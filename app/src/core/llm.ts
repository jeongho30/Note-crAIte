// OpenAI 호환 chat completions 호출. pipeline/process_lecture.py의 generate_note() 호출부를 옮겨 온 것이다.
// API 키는 요청 헤더에만 쓰고 로그·예외 메시지에 넣지 않는다.
import { EngineError } from './errors.ts'

const STATUS_ERRORS: Record<number, [string, string]> = {
  401: ['auth', 'API 키가 올바르지 않아요. 설정에서 키를 확인해 주세요.'],
  403: ['auth', 'API 키에 이 기능을 쓸 권한이 없어요.'],
  402: ['credits', '크레딧이 부족해요.'],
  413: ['too_large', '전사문이 너무 길어 요약 서버가 받지 않았어요.'],
  429: ['rate_limit', '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.']
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

export type ChatOptions = { maxTokens?: number; responseFormat?: object; timeoutMs?: number }

/** [응답 본문, usage]를 돌려준다. */
export async function chat(endpoint: string, apiKey: string | null, model: string, messages: Message[],
                           { maxTokens = 8192, responseFormat, timeoutMs = 300_000 }: ChatOptions = {}): Promise<[string, Usage | null]> {
  const body: Record<string, unknown> = { model, messages, max_tokens: maxTokens }
  if (responseFormat) body['response_format'] = responseFormat
  const resp = await request(endpoint, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body) }, timeoutMs, '요약')
  await raiseForStatus(resp, '요약')
  const data = (await resp.json()) as { choices: { message: { content?: string | null } }[]; usage?: Usage }
  const content = (data.choices[0].message.content ?? '').trim()
  // 추론 모델은 max_tokens 안에서 생각하다 본문 없이 끝날 수 있다 (ChatKHU 문서)
  if (!content) throw new EngineError('llm', '요약 모델이 빈 응답을 돌려줬어요.')
  return [content, data.usage ?? null]
}
