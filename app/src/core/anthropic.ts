// Claude API 호출 (네이티브 Messages API). OpenAI 호환 형식과 헤더·system 위치·스트림 형식·응답 형식 지정이 달라 따로 둔다.
// 다른 서비스처럼 SDK 없이 fetch로 부른다 (10/2 작성자 결정). 실제 키로는 아직 못 불러 봤고 가짜 서버 테스트만 있다.
import { EngineError } from './errors.ts'
import { raiseForStatus, request } from './llm.ts'
import type { Message, Usage } from './llm.ts'

export function anthropicHeaders(apiKey: string | null): Record<string, string> {
  return { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', ...(apiKey ? { 'x-api-key': apiKey } : {}) }
}

// 생각을 하는 모델은 생각도 출력 상한에 들어간다. 상한이 작으면 본문 전에 끊기므로 넉넉히 준다 (지금 모델들의 최대 출력은 64K 이상)
const MIN_MAX_TOKENS = 32_000

type Event = {
  type?: string
  message?: { usage?: { input_tokens?: number } }
  delta?: { type?: string; text?: string; stop_reason?: string }
  usage?: { output_tokens?: number }
  error?: { type?: string; message?: string }
}

export type AnthropicOptions = { maxTokens: number; schema?: object; timeoutMs: number }

/**
 * [응답 본문, usage]를 돌려준다. usage.done_reason이 length면 출력이 상한에 걸려 끊긴 것이다(로컬 LLM과 같은 표시).
 * 시스템 메시지는 system으로 올리고, 스키마가 있으면 output_config.format으로 JSON 형식을 강제한다.
 */
export async function chat(endpoint: string, apiKey: string | null, model: string, messages: Message[], o: AnthropicOptions): Promise<[string, Usage]> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const body: Record<string, unknown> = {
    model,
    max_tokens: Math.max(o.maxTokens, MIN_MAX_TOKENS),
    stream: true,
    ...(system ? { system } : {}),
    messages: messages.filter((m) => m.role !== 'system'),
    ...(o.schema ? { output_config: { format: { type: 'json_schema', schema: o.schema } } } : {})
  }
  const resp = await request(endpoint, { method: 'POST', headers: anthropicHeaders(apiKey), body: JSON.stringify(body) }, o.timeoutMs, '요약')
  await raiseForStatus(resp, '요약')

  let content = ''
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  let stopReason: string | undefined
  const handle = (line: string): void => {
    if (!line.startsWith('data:')) return
    const e = JSON.parse(line.slice(5).trim()) as Event
    if (e.type === 'error') {
      // 스트림 도중의 과부하 등
      if (e.error?.type === 'overloaded_error') throw new EngineError('network', '요약 서버가 붐벼요. 잠시 후 다시 시도해 주세요.')
      throw new EngineError('llm', `요약 오류: ${String(e.error?.message ?? '').slice(0, 500)}`)
    }
    if (e.type === 'message_start') inputTokens = e.message?.usage?.input_tokens
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') content += e.delta.text ?? ''
    if (e.type === 'message_delta') {
      stopReason = e.delta?.stop_reason ?? stopReason
      outputTokens = e.usage?.output_tokens ?? outputTokens
    }
  }
  try {
    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
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
  } catch (e) {
    if (e instanceof EngineError) throw e
    if (e instanceof Error && e.name === 'TimeoutError') throw new EngineError('timeout', '요약 모델이 제때 답하지 않아 연결이 끊겼어요. 더 빠른 요약 모델로 바꾼 뒤 다시 시도해 주세요.')
    throw new EngineError('network', '요약 답을 받다가 연결이 끊겼어요. 다시 시도해 주세요.')
  }
  if (stopReason === 'refusal') throw new EngineError('llm', '모델이 이 내용에 답하기를 거절했어요. 다른 요약 모델로 다시 시도해 주세요.')
  const text = content.trim()
  const length = stopReason === 'max_tokens'
  if (!text && !length) throw new EngineError('llm', '요약 모델이 빈 응답을 돌려줬어요.')
  return [text, { prompt_tokens: inputTokens, completion_tokens: outputTokens, ...(length ? { done_reason: 'length' } : {}) }]
}
