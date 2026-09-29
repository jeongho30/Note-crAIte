// 요약 공급자 프리셋. 엔드포인트는 전체 URL로 둔다 (ChatKHU는 문서대로 끝에 /를 붙인다).
// OpenAI·Gemini는 W3, Ollama(네이티브 /api/chat)는 W4에 붙인다.
import * as credits from './credits.ts'
import { EngineError } from './errors.ts'
import type { Job } from './job.ts'
import { headers, raiseForStatus, request } from './llm.ts'

export const CHATKHU_BASE = 'https://factchat-cloud.mindlogic.ai/v1/gateway'

export type ProviderId = 'chatkhu' | 'openai' | 'claude' | 'gemini'

/** 화면에 보이는 요약 서비스 목록. available이 false면 "곧 지원"으로 흐리게 보인다. */
export const PROVIDERS: { id: ProviderId; name: string; available: boolean; keyGuideUrl?: string }[] = [
  { id: 'chatkhu', name: 'ChatKHU', available: true, keyGuideUrl: 'https://chat.khu.ac.kr/' },
  { id: 'openai', name: 'OpenAI', available: false },
  { id: 'claude', name: 'Claude', available: false },
  { id: 'gemini', name: 'Gemini', available: false }
]

/** 90분 강의 요약 1회의 크레딧. S2 실측(63분, turbo 전사 7.3~9.3크레딧)을 90분으로 환산했다. */
export const CREDITS_PER_90MIN_SUMMARY = 12

/** 써 보기 전에도 알고 있는 모델별 90분 요약 크레딧 (S2 실측을 90분으로 환산). 나머지는 한 번 써 본 뒤 기록으로 안다. */
const KNOWN_CREDITS_PER_90MIN: Record<string, number> = {
  'gemini-3.8-flash': CREDITS_PER_90MIN_SUMMARY,
  'gemini-3.5-flash-lite': 9
}

/** 모델별 90분 요약 크레딧: 끝난 작업의 기록(잔액 차이)을 90분으로 환산한 평균, 기록이 없으면 알려진 값. */
export function creditsPer90ByModel(jobs: Job[]): Record<string, number> {
  const sums: Record<string, { total: number; n: number }> = {}
  for (const j of jobs) {
    const model = j.settings.llm?.model
    const used = j.cost?.summaryCredits
    const durationS = j.audio?.durationS
    if (!model || used == null || !durationS || durationS < 60) continue
    const s = (sums[model] ??= { total: 0, n: 0 })
    s.total += (used / durationS) * 5400
    s.n++
  }
  const out: Record<string, number> = { ...KNOWN_CREDITS_PER_90MIN }
  for (const [model, s] of Object.entries(sums)) out[model] = Math.round((s.total / s.n) * 10) / 10
  return out
}

/** 모델 목록 응답에서 모델 이름만 뽑는다. OpenAI 형식({ data: [{ id }] })과 이름 배열을 모두 받는다. */
export function parseModelList(data: unknown): string[] {
  const items = Array.isArray(data) ? data : ((data as { data?: unknown; models?: unknown })?.data ?? (data as { models?: unknown })?.models)
  if (!Array.isArray(items)) return []
  const ids = items.map((m) => (typeof m === 'string' ? m : (m as { id?: unknown; name?: unknown })?.id ?? (m as { name?: unknown })?.name))
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
}

/** 요약 서비스가 제공하는 모델 목록. 목록 주소가 없는 서비스는 권장 모델만. */
export async function listModels(id: ProviderId, apiKey: string): Promise<string[]> {
  const url = PRESETS[id]?.models
  if (!url) return PRESETS[id] ? [PRESETS[id].model] : []
  const resp = await request(url, { headers: headers(apiKey) }, 15_000, '모델 목록')
  await raiseForStatus(resp, '모델 목록')
  return parseModelList(await resp.json())
}

/** 키를 확인한다. 잔액을 볼 수 있는 서비스(ChatKHU)는 남은 크레딧을 돌려준다. 요금이 드는 호출은 하지 않는다. */
export async function verifyKey(id: ProviderId, apiKey: string): Promise<{ credits: number | null }> {
  if (id === 'chatkhu') return { credits: credits.remaining(await credits.get(PRESETS['chatkhu'].credits!, apiKey)) }
  throw new EngineError('input', '아직 지원하지 않는 요약 서비스예요.')
}

export type Preset = { endpoint: string; credits?: string; models?: string; model: string }

export const PRESETS: Record<string, Preset> = {
  chatkhu: {
    endpoint: `${CHATKHU_BASE}/chat/completions/`,
    credits: `${CHATKHU_BASE}/credits/`,
    models: `${CHATKHU_BASE}/models/`,
    model: 'gemini-3.8-flash'
  }
}
