// 요약 뒤 교정 검증: 요약 호출이 낸 교정 항목마다 전사에서 바꿀 곳의 앞뒤 문맥을 잘라 보여 주고,
// 두 번째 호출로 유지/버림을 받는다. 전사 전체를 다시 보내지 않아 싸다.
// 9/30 실험(docs/decisions.md): 맞게 받아쓴 말의 표기만 바꾸는 교정을 거의 다 거르고, 잘못된 교정을 절반 넘게 막았다.
import type { Correction } from './corrections.ts'
import { occurrences } from './corrections.ts'
import { chat } from './llm.ts'
import type { Usage } from './llm.ts'
import { VERIFY_CORRECTIONS } from './prompts.ts'

const SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'integer' }, keep: { type: 'boolean' } }, required: ['id', 'keep'], additionalProperties: false }
    }
  },
  required: ['results'],
  additionalProperties: false
}

const CONTEXT_CHARS = 30
const MAX_CONTEXTS = 3

export type VerifyOptions = { endpoint: string; apiKey: string | null; model: string }

/** 교정 항목의 문맥 목록을 만든다: 전사에서 바꿀 곳마다(최대 3곳) 앞뒤 30자, 바꿀 말은 【 】로 */
export function verifyInput(text: string, items: Correction[], subject: string | null): string {
  const lines = items.map((c, id) => {
    const at = occurrences(text, c.wrong)
    const ctx = at.slice(0, MAX_CONTEXTS).map((i) => {
      const before = text.slice(Math.max(0, i - CONTEXT_CHARS), i)
      const after = text.slice(i + c.wrong.length, i + c.wrong.length + CONTEXT_CHARS)
      return `   - ${(before + '【' + c.wrong + '】' + after).replace(/\s+/g, ' ')}`
    })
    return [`${id}. ${c.wrong} → ${c.right} (${at.length}곳)`, ...ctx].join('\n')
  })
  return `[과목]\n${subject || '(미지정)'}\n\n[교정 목록]\n${lines.join('\n')}`
}

/** keep이 true인 항목만 남긴다. 판정이 빠진 항목은 버린다. 항목이 없으면 호출하지 않는다. */
export async function verifyCorrections(text: string, items: Correction[], subject: string | null,
                                        o: VerifyOptions): Promise<{ kept: Correction[]; rejected: Correction[]; usage: Usage | null }> {
  if (!items.length) return { kept: [], rejected: [], usage: null }
  const [content, usage] = await chat(o.endpoint, o.apiKey, o.model,
    [{ role: 'system', content: VERIFY_CORRECTIONS }, { role: 'user', content: verifyInput(text, items, subject) }],
    { responseFormat: { type: 'json_schema', json_schema: { name: 'verify', strict: true, schema: SCHEMA } } })
  const results = (JSON.parse(content) as { results?: { id?: unknown; keep?: unknown }[] }).results
  if (!Array.isArray(results)) throw new Error('검증 응답에 results가 없어요')
  const keep = new Set(results.filter((r) => r.keep === true).map((r) => r.id))
  return { kept: items.filter((_, i) => keep.has(i)), rejected: items.filter((_, i) => !keep.has(i)), usage }
}
