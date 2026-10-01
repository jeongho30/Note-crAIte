// 요약 호출 한 번으로 제목·요약·키워드·교정 목록을 받는다 (API 통합 모드).
// 응답 파싱과 폴백은 pipeline/process_lecture.py의 generate_note()를 옮겨 온 것이다.
import { EngineError } from './errors.ts'
import { chat } from './llm.ts'
import type { Message, Usage } from './llm.ts'
import type { OllamaRequest } from './ollama.ts'
import { SUMMARY_UNIFIED } from './prompts.ts'

export const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    corrections: {
      type: 'array',
      items: {
        type: 'object',
        properties: { wrong: { type: 'string' }, right: { type: 'string' } },
        required: ['wrong', 'right'],
        additionalProperties: false
      }
    }
  },
  required: ['title', 'summary', 'keywords', 'corrections'],
  additionalProperties: false
}

export type Summary = {
  title: string
  summary: string
  keywords: string[]
  corrections: unknown[] // corrections.select()가 검사한다
  parseFailed: boolean
}

export function buildMessages(transcript: string, notes: string, subject: string | null): Message[] {
  const user = `[과목]\n${subject || '(미지정)'}\n\n[필기노트]\n${notes || '(없음)'}\n\n[전사]\n${transcript}`
  return [{ role: 'system', content: SUMMARY_UNIFIED }, { role: 'user', content: user }]
}

function strip(raw: string, prefix: string, suffix = ''): string {
  let s = raw
  if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length)
  if (suffix && s.endsWith(suffix)) s = s.slice(0, -suffix.length)
  return s
}

export function parseResponse(raw: string, fallbackTitle: string): Summary {
  raw = strip(strip(strip(raw.trim(), '```json'), '```'), '', '```').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    // 파싱에 실패하면 원문을 요약란에 넣는다 (기존 파이프라인과 같은 폴백). 교정은 적용하지 않는다.
    return { title: fallbackTitle, summary: raw, keywords: [], corrections: [], parseFailed: true }
  }
  const p = parsed as Record<string, unknown>
  return {
    title: String(p['title'] || fallbackTitle).trim(),
    summary: String(p['summary'] || '').trim(),
    keywords: Array.isArray(p['keywords']) ? p['keywords'].map((k) => String(k).trim()).filter(Boolean) : [],
    corrections: Array.isArray(p['corrections']) ? p['corrections'] : [],
    parseFailed: false
  }
}

export type SummarizeOptions = {
  endpoint: string
  apiKey: string | null
  model: string
  fallbackTitle: string
  useSchema?: boolean
  maxTokens?: number
  /** 있으면 로컬 LLM(Ollama)으로 요약한다. 요약이 작업의 마지막 호출이라 끝나면 모델을 내린다 */
  ollama?: OllamaRequest
  signal?: AbortSignal
}

export async function summarize(transcript: string, notes: string, subject: string | null,
                                o: SummarizeOptions): Promise<Summary & { usage: Usage | null }> {
  const responseFormat = o.useSchema === false
    ? undefined
    : { type: 'json_schema', json_schema: { name: 'lecture_note', strict: true, schema: SCHEMA } }
  const [content, usage] = await chat(o.endpoint, o.apiKey, o.model, buildMessages(transcript, notes, subject),
                                      { maxTokens: o.maxTokens, responseFormat, ollama: o.ollama, signal: o.signal, unloadAfter: true })
  if (usage?.['done_reason'] === 'length') {
    throw new EngineError('llm', '요약이 출력 상한에 걸려 끊겼어요. 설정 > 고급 > 로컬 LLM의 요약 요청 옵션에 num_predict를 넣어 늘려 주세요.')
  }
  return { ...parseResponse(content, o.fallbackTitle), usage }
}
