// 로컬 LLM(Ollama) 호출. OpenAI 호환 주소는 요청마다 컨텍스트 길이를 못 정해서 네이티브 /api/chat을 쓴다 (9/28 결정).
// 10/2 Ollama 0.35에서 확인한 것: 컨텍스트를 넘는 입력은 말없이 앞에서 잘리고, truncate: false를 주면 대신
// 400(exceed_context_size_error, n_prompt_tokens·n_ctx)이 온다. 출력이 num_predict에 걸리면 done_reason이 length다.
import { EngineError } from './errors.ts'
import type { Message, Usage } from './llm.ts'

export const OLLAMA_BASE = 'http://127.0.0.1:11434' // localhost는 IPv6(::1)로 풀려 연결이 안 되는 경우가 있다

/** 설정 > 고급 > 로컬 LLM에서 고칠 수 있는 요청 부분. options.num_ctx는 숫자이거나 "auto"(입력 길이로 계산) */
export type OllamaRequest = { think?: unknown; options?: Record<string, unknown>; [k: string]: unknown }

/** 앱이 정하는 키. 사용자 옵션에 들어 있으면 거절한다. */
const LOCKED = ['model', 'messages', 'stream', 'format', 'keep_alive', 'truncate', 'tools']

export const DEFAULT_REQUEST: Record<'polish' | 'summary', OllamaRequest> = {
  polish: { think: false, options: { num_ctx: 16384 } },
  summary: { think: false, options: { num_ctx: 'auto' } }
}

/** 화면에 보이는 한 줄 JSON */
export function requestText(r: OllamaRequest): string {
  return JSON.stringify(r)
}

/** 사용자가 입력한 요청 옵션(JSON)을 읽는다. 잠긴 키나 잘못된 num_ctx는 이유와 함께 거절한다. */
export function parseRequest(text: string): OllamaRequest {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    throw new EngineError('input', '요청 옵션은 JSON이어야 해요. 예: {"think": false, "options": {"num_ctx": 16384}}')
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new EngineError('input', '요청 옵션은 { }로 감싼 JSON이어야 해요.')
  const r = v as OllamaRequest
  for (const k of LOCKED) if (k in r) throw new EngineError('input', `${k}는 앱이 정하는 값이라 바꿀 수 없어요.`)
  if (r.options !== undefined && (typeof r.options !== 'object' || r.options === null || Array.isArray(r.options))) {
    throw new EngineError('input', 'options는 { }로 감싼 값이어야 해요.')
  }
  const ctx = r.options?.['num_ctx']
  if (ctx !== undefined && ctx !== 'auto' && !(Number.isInteger(ctx) && (ctx as number) > 0)) {
    throw new EngineError('input', 'num_ctx는 양의 정수이거나 "auto"여야 해요.')
  }
  return r
}

const CTX_STEP = 4096
// 한글 1자당 토큰 수 어림 (gemma4 실측 0.58). 모자라면 서버가 알려 준 토큰 수로 한 번 다시 보낸다
const TOKENS_PER_CHAR = 0.75

const roundCtx = (tokens: number): number => Math.ceil(tokens / CTX_STEP) * CTX_STEP

/** num_ctx "auto": 입력 글자 수로 어림한 토큰 + 출력 몫을 4096 단위로 올린 값 */
export function autoNumCtx(inputChars: number, outputTokens: number): number {
  return roundCtx(inputChars * TOKENS_PER_CHAR + outputTokens + 512)
}

async function errorText(resp: Response): Promise<string> {
  const raw = await resp.text()
  try {
    return String((JSON.parse(raw) as { error?: unknown }).error ?? raw)
  } catch {
    return raw
  }
}

function connectError(e: unknown): EngineError {
  const code = (e as { cause?: { code?: string } }).cause?.code
  if (code === 'ECONNREFUSED') return new EngineError('network', 'Ollama에 연결하지 못했어요. Ollama가 켜져 있는지 확인해 주세요.')
  return new EngineError('network', `Ollama에 연결하지 못했어요: ${code ?? (e as Error).name}`)
}

/** Ollama가 돌려준 오류: 누구 쪽 문제인지와 할 일을 먼저 적고, Ollama의 원문은 뒤에 붙인다 */
function serverError(status: number, message: string): EngineError {
  const raw = `(Ollama 오류 ${status}: ${message.slice(0, 500)})`
  if (status >= 500) return new EngineError('llm', `Ollama 프로그램에서 오류가 났어요. Ollama를 다시 켜 보고, 그래도 안 되면 다시 설치해 주세요. ${raw}`)
  return new EngineError('llm', `Ollama가 요청을 받아들이지 않았어요. 설정 > 고급 > 로컬 LLM의 모델과 요청 옵션을 확인해 주세요. ${raw}`)
}

async function get(base: string, path: string, init?: RequestInit): Promise<Response> {
  let resp: Response
  try {
    resp = await fetch(base + path, { ...init, signal: AbortSignal.timeout(5000) })
  } catch (e) {
    throw connectError(e)
  }
  if (resp.status !== 200) throw serverError(resp.status, await errorText(resp))
  return resp
}

export async function version(base = OLLAMA_BASE): Promise<string> {
  return String(((await (await get(base, '/api/version')).json()) as { version?: unknown }).version ?? '')
}

export type OllamaModel = { id: string; bytes: number; parameters: string | null; quantization: string | null; contextLength: number | null }

/** 설치된 모델 가운데 글을 만드는 것(임베딩 모델은 뺀다) */
export async function listModels(base = OLLAMA_BASE): Promise<OllamaModel[]> {
  type Item = { name: string; size?: number; details?: { parameter_size?: string; quantization_level?: string; context_length?: number }; capabilities?: string[] }
  const data = (await (await get(base, '/api/tags')).json()) as { models?: Item[] }
  return (data.models ?? [])
    .filter((m) => !m.capabilities || m.capabilities.includes('completion'))
    .map((m) => ({
      id: m.name,
      bytes: m.size ?? 0,
      parameters: m.details?.parameter_size ?? null,
      quantization: m.details?.quantization_level ?? null,
      contextLength: m.details?.context_length ?? null
    }))
}

/** 모델을 메모리에서 내린다 (실패·취소로 마지막 호출의 keep_alive: 0이 못 갔을 때). 안 돼도 넘어간다 */
export async function unload(endpoint: string, model: string): Promise<void> {
  await fetch(endpoint, { method: 'POST', body: JSON.stringify({ model, messages: [], keep_alive: 0 }), signal: AbortSignal.timeout(5000) }).catch(() => {})
}

export type OllamaChatOptions = {
  request: OllamaRequest
  /** 출력 토큰 상한. 사용자가 options.num_predict를 넣었으면 그것을 쓴다 */
  maxTokens: number
  /** 응답 JSON 스키마 (요약) */
  format?: object
  /** 이 호출 뒤 모델을 내린다 (작업의 마지막 로컬 호출) */
  unloadAfter?: boolean
  signal?: AbortSignal
  /** 첫 조각까지(모델 올리기 + 입력 읽기)와 조각 사이의 시간 제한 */
  firstMs?: number
  idleMs?: number
}

// think를 받지 않는 모델 (한 번 거절당하면 앱이 꺼질 때까지 think 없이 보낸다)
const noThink = new Set<string>()

type Line = {
  message?: { content?: string }; done?: boolean; done_reason?: string; error?: string
  prompt_eval_count?: number; eval_count?: number; load_duration?: number; eval_duration?: number
}

/**
 * [응답 본문, usage]를 돌려준다. usage.done_reason이 length면 출력이 상한에 걸려 끊긴 것이다.
 * 입력이 컨텍스트를 넘으면 자르지 않고 오류로 끝낸다. num_ctx가 "auto"면 서버가 알려 준 토큰 수로 한 번 다시 보낸다.
 */
export async function chat(endpoint: string, model: string, messages: Message[], o: OllamaChatOptions): Promise<[string, Usage]> {
  const { think, options = {}, ...rest } = o.request
  const numPredict = typeof options['num_predict'] === 'number' ? options['num_predict'] : o.maxTokens
  const auto = options['num_ctx'] === 'auto'
  let numCtx = auto ? autoNumCtx(messages.reduce((n, m) => n + m.content.length, 0), numPredict) : (options['num_ctx'] as number | undefined)

  for (let attempt = 0; ; attempt++) {
    const body: Record<string, unknown> = {
      ...rest,
      ...(think !== undefined && !noThink.has(model) ? { think } : {}),
      model,
      messages,
      stream: true,
      truncate: false,
      options: { ...options, num_predict: numPredict, ...(numCtx !== undefined ? { num_ctx: numCtx } : {}) },
      ...(o.format ? { format: o.format } : {}),
      ...(o.unloadAfter ? { keep_alive: 0 } : {})
    }
    // 시간 제한: 첫 조각까지와 조각 사이를 따로 본다. 로컬은 입력을 읽는 데만 몇 분이 걸릴 수 있다
    const timer = new AbortController()
    let timeout = setTimeout(() => timer.abort(), o.firstMs ?? 30 * 60_000)
    const signal = o.signal ? AbortSignal.any([o.signal, timer.signal]) : timer.signal
    try {
      const resp = await fetch(endpoint, { method: 'POST', body: JSON.stringify(body), signal })
      if (resp.status !== 200) {
        const message = await errorText(resp)
        if (resp.status === 400 && 'think' in body && /think/i.test(message)) {
          noThink.add(model)
          continue
        }
        const over = /exceed_context_size_error/.test(message) ? /"n_prompt_tokens":\s*(\d+).*?"n_ctx":\s*(\d+)/.exec(message) : null
        if (over) {
          const [promptTokens, ctx] = [Number(over[1]), Number(over[2])]
          const need = roundCtx(promptTokens + numPredict)
          // 요청한 num_ctx보다 작게 잡혔으면 모델의 최대 컨텍스트에 걸린 것이라 다시 보내도 같다
          if (auto && attempt < 2 && need > numCtx! && ctx >= numCtx!) {
            numCtx = need
            continue
          }
          throw new EngineError('too_large', `입력이 컨텍스트보다 길어요 (입력 ${promptTokens.toLocaleString()}토큰, num_ctx ${ctx.toLocaleString()}). 설정 > 고급 > 로컬 LLM에서 num_ctx를 늘리거나 컨텍스트가 더 긴 모델을 골라 주세요.`)
        }
        if (resp.status === 404) throw new EngineError('input', `Ollama에 ${model} 모델이 없어요. 설정 > 고급 > 로컬 LLM에서 모델을 다시 골라 주세요.`)
        if (/memory|allocate|VRAM/i.test(message)) throw new EngineError('llm', `Ollama가 모델을 올리지 못했어요(메모리 부족). num_ctx를 줄이거나 더 작은 모델을 골라 주세요: ${message.slice(0, 300)}`)
        throw serverError(resp.status, message)
      }
      let content = ''
      let last: Line = {}
      const handle = (line: string): void => {
        if (!line) return
        const chunk = JSON.parse(line) as Line
        if (chunk.error) throw new EngineError('llm', `Ollama가 답을 만들다가 오류를 냈어요. Ollama를 다시 켜고 다시 시도해 주세요. (Ollama 오류: ${chunk.error.slice(0, 500)})`)
        content += chunk.message?.content ?? ''
        if (chunk.done) last = chunk
      }
      const reader = resp.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        clearTimeout(timeout)
        timeout = setTimeout(() => timer.abort(), o.idleMs ?? 5 * 60_000)
        buf += decoder.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          handle(buf.slice(0, i).trim())
          buf = buf.slice(i + 1)
        }
      }
      handle(buf.trim())
      const usage: Usage = {
        prompt_tokens: last.prompt_eval_count, completion_tokens: last.eval_count, done_reason: last.done_reason, num_ctx: numCtx,
        load_duration: last.load_duration, eval_duration: last.eval_duration // 나노초
      }
      if (!content.trim() && last.done_reason !== 'length') throw new EngineError('llm', '로컬 모델이 빈 응답을 돌려줬어요.')
      return [content.trim(), usage]
    } catch (e) {
      if (e instanceof EngineError) throw e
      if (o.signal?.aborted) throw new EngineError('cancelled', '작업을 취소했습니다.')
      if (timer.signal.aborted) throw new EngineError('timeout', '로컬 모델이 제때 답하지 않았어요. 더 작은 모델이나 더 짧은 컨텍스트로 다시 시도해 주세요.')
      if (e instanceof SyntaxError) throw new EngineError('llm', 'Ollama의 답을 읽지 못했어요.')
      throw connectError(e)
    } finally {
      clearTimeout(timeout)
    }
  }
}
