// 요약 호출 한 번으로 제목·요약·키워드·교정 목록을 받는다 (API 통합 모드).
// 응답 파싱과 폴백은 pipeline/process_lecture.py의 generate_note()를 옮겨 온 것이다.
import { EngineError } from './errors.ts'
import { chat } from './llm.ts'
import type { Message, Usage } from './llm.ts'
import type { OllamaRequest } from './ollama.ts'
import { SUMMARY_EXTRA_HEADER, SUMMARY_UNIFIED } from './prompts.ts'

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

/**
 * 요약 서비스에 보내는 출력 상한. 추론 토큰도 여기에 들어가서, 주제별 틀(10/2)로 요약이 길어지자 chat()의 기본 8,192에
 * deepseek-v4-flash가 걸렸다(9,518토큰, 요약이 중간에 끊김). 10/2 비교의 6개 모델은 16,000으로 문제없이 돌았다.
 * 로컬 LLM은 상한이 컨텍스트 크기 계산에 들어가므로 chat()의 기본값을 그대로 쓴다.
 */
export const SUMMARY_MAX_TOKENS = 16_000

export type Summary = {
  title: string
  summary: string
  keywords: string[]
  corrections: unknown[] // corrections.select()가 검사한다
  parseFailed: boolean
}

/**
 * 사용자가 고친 요약 프롬프트 (설정 > 고급 > 요약 세부설정).
 * extra는 기본 프롬프트 뒤에 붙는 추가 지시, custom은 기본 프롬프트를 통째로 바꾼 글. 없으면(null) 앱 기본이다.
 */
export type PromptOverride = { extra: string | null; custom: string | null }

/** 설정에 저장할 값으로 다듬는다: 빈 글과, 기본 프롬프트와 같은 고친 프롬프트는 없는 것으로 둔다 (앱이 기본 프롬프트를 고치면 따라가게) */
export function cleanPrompt(extra: unknown, custom: unknown): PromptOverride {
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const edited = text(custom)
  return { extra: text(extra), custom: edited === SUMMARY_UNIFIED.trim() ? null : edited }
}

/** 요약 호출의 시스템 프롬프트. 고친 것이 없으면 SUMMARY_UNIFIED 그대로다 */
export function systemPrompt(p?: PromptOverride | null): string {
  const base = p?.custom ?? SUMMARY_UNIFIED
  return p?.extra ? `${base.trimEnd()}\n\n${SUMMARY_EXTRA_HEADER}\n${p.extra}\n` : base
}

export function buildMessages(transcript: string, notes: string, subject: string | null, prompt?: PromptOverride | null): Message[] {
  const user = `[과목]\n${subject || '(미지정)'}\n\n[필기노트]\n${notes || '(없음)'}\n\n[전사]\n${transcript}`
  return [{ role: 'system', content: systemPrompt(prompt) }, { role: 'user', content: user }]
}

function strip(raw: string, prefix: string, suffix = ''): string {
  let s = raw
  if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length)
  if (suffix && s.endsWith(suffix)) s = s.slice(0, -suffix.length)
  return s
}

const UNESCAPED: Record<string, string> = { '\t': '\\t', '\r': '\\r', '\f': '\\f', '\b': '\\b' }

/**
 * 모델이 JSON 문자열 안의 LaTeX 역슬래시를 겹쳐 쓰지 않으면 JSON.parse가 명령의 앞 두 글자를 제어 문자로 푼다
 * ($\theta$ → 탭 + heta, \rightarrow → CR + ightarrow, \frac → 폼피드 + rac, \beta → 백스페이스 + eta).
 * 10/2 비교에서 gemma는 요약 16개 중 7개가 이렇게 깨졌다. 영문자가 바로 뒤따르는 제어 문자만 되살린다:
 * 폼피드·백스페이스는 어디서나, 탭·CR은 한 줄 안의 $…$ 수식 안에서만(목록 들여쓰기의 탭이나 CRLF는 건드리지 않는다).
 * \nu·\neq처럼 \n으로 시작하는 명령은 진짜 줄바꿈과 가릴 수 없어 못 되살린다.
 */
export function restoreLatex(s: string): string {
  return s
    .replace(/[\f\b](?=[A-Za-z])/g, (c) => UNESCAPED[c])
    .replace(/\$[^$\n]*\$/g, (math) => math.replace(/[\t\r](?=[A-Za-z])/g, (c) => UNESCAPED[c]))
}

/** before의 끝이 word와 같은 말로 끝나는지 (대소문자·공백 차이는 무시, 더 긴 낱말의 일부면 아니다) */
function endsWithWord(before: string, word: string): boolean {
  let b = before.length - 1
  for (let w = word.length - 1; w >= 0; w--) {
    if (/\s/.test(word[w])) continue
    while (b >= 0 && /\s/.test(before[b])) b--
    if (b < 0 || before[b].toLowerCase() !== word[w].toLowerCase()) return false
    b--
  }
  return b < 0 || !/[\p{L}\p{N}]/u.test(before[b])
}

/**
 * 용어 뒤 괄호가 앞 말을 그대로 되풀이하면 괄호를 지운다: **Closure**(Closure) → **Closure**, **LR(k)**(LR(k)) → **LR(k)**.
 * "한글(English)" 병기 규칙을, 강의에서 영어로 말한 용어에 그대로 적용한 모델이 이렇게 쓴다(10/4, luna).
 * 괄호 안이 한 글자인 것(S(S) 같은 문법 기호)과 $수식$·`코드` 안은 건드리지 않는다.
 */
export function dropEchoedGloss(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '$' || c === '`') {
      const end = s.indexOf(c, i + 1)
      if (end > 0 && !s.slice(i, end).includes('\n')) {
        out += s.slice(i, end + 1)
        i = end
        continue
      }
    }
    if (c === '(') {
      let close = -1
      for (let k = i, depth = 0; k < s.length && s[k] !== '\n'; k++) {
        if (s[k] === '(') depth++
        else if (s[k] === ')' && --depth === 0) {
          close = k
          break
        }
      }
      const inner = close > 0 ? s.slice(i + 1, close).trim() : ''
      const before = out.replace(/[ \t]+$/, '')
      if (inner.length >= 2 && endsWithWord(before.replace(/\*+$/, ''), inner)) {
        out = before
        i = close
        continue
      }
    }
    out += c
  }
  return out
}

function restoreCorrection(c: unknown): unknown {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return c
  const o = c as Record<string, unknown>
  return {
    ...o,
    ...(typeof o['wrong'] === 'string' ? { wrong: restoreLatex(o['wrong']) } : {}),
    ...(typeof o['right'] === 'string' ? { right: restoreLatex(o['right']) } : {})
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    // \alpha·\sum처럼 JSON에 없는 이스케이프는 파싱 자체가 실패한다. 그런 역슬래시만 겹쳐 한 번 더 읽어 본다.
    // 역슬래시와 그 다음 글자를 짝으로 읽어야 이미 겹쳐 쓴 \\alpha를 건드리지 않는다.
    try {
      return JSON.parse(raw.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (m, next: string) => (next.length > 1 || '"\\/bfnrt'.includes(next) ? m : '\\\\' + next)))
    } catch {
      return null
    }
  }
}

export function parseResponse(raw: string, fallbackTitle: string): Summary {
  raw = strip(strip(strip(raw.trim(), '```json'), '```'), '', '```').trim()
  const parsed = parseJson(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    // 파싱에 실패하면 원문을 요약란에 넣는다 (기존 파이프라인과 같은 폴백). 교정은 적용하지 않는다.
    return { title: fallbackTitle, summary: raw, keywords: [], corrections: [], parseFailed: true }
  }
  const p = parsed as Record<string, unknown>
  return {
    title: restoreLatex(String(p['title'] || fallbackTitle)).trim(),
    // 모델이 값의 앞뒤에 필드 이름으로 된 태그를 흘릴 때가 있다 (10/4: 요약 끝에 </summary>, 약 290개 중 1개)
    summary: dropEchoedGloss(restoreLatex(String(p['summary'] || ''))).trim().replace(/^<summary>\s*|\s*<\/summary>$/g, ''),
    keywords: Array.isArray(p['keywords']) ? p['keywords'].map((k) => restoreLatex(String(k)).trim()).filter(Boolean) : [],
    corrections: Array.isArray(p['corrections']) ? p['corrections'].map(restoreCorrection) : [],
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
  /** 서비스 id (호출 형식이 서비스마다 다르다, llm.ts의 chat) */
  service?: string
  /** 있으면 로컬 LLM(Ollama)으로 요약한다. 요약이 작업의 마지막 호출이라 끝나면 모델을 내린다 */
  ollama?: OllamaRequest
  /** 사용자가 고친 요약 프롬프트 */
  prompt?: PromptOverride | null
  signal?: AbortSignal
}

export async function summarize(transcript: string, notes: string, subject: string | null,
                                o: SummarizeOptions): Promise<Summary & { usage: Usage | null }> {
  const responseFormat = o.useSchema === false
    ? undefined
    : { type: 'json_schema', json_schema: { name: 'lecture_note', strict: true, schema: SCHEMA } }
  const [content, usage] = await chat(o.endpoint, o.apiKey, o.model, buildMessages(transcript, notes, subject, o.prompt),
                                      { maxTokens: o.maxTokens ?? (o.ollama ? undefined : SUMMARY_MAX_TOKENS), responseFormat, service: o.service, ollama: o.ollama, signal: o.signal, unloadAfter: true })
  if (usage?.['done_reason'] === 'length') {
    throw new EngineError('llm', o.ollama
      ? '요약이 출력 상한에 걸려 끊겼어요. 설정 > 고급 > 로컬 LLM의 요약 요청 옵션에 num_predict를 넣어 늘려 주세요.'
      : '요약이 출력 상한에 걸려 끊겼어요. 다른 요약 모델로 다시 시도해 주세요.')
  }
  return { ...parseResponse(content, o.fallbackTitle), usage }
}
