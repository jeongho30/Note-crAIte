// 요약 공급자 프리셋. 엔드포인트는 전체 URL로 둔다 (ChatKHU는 문서대로 끝에 /를 붙인다).
// OpenAI·Gemini는 W3에 붙인다. 로컬 LLM(Ollama)은 키로 연결하는 서비스가 아니라 단계마다 고르는 것이다(resolveSteps).
import * as credits from './credits.ts'
import { EngineError } from './errors.ts'
import type { Job, LlmSettings } from './job.ts'
import { headers, raiseForStatus, request } from './llm.ts'
import { parseModelList } from './llmcatalog.ts'
import type { ModelItem } from './llmcatalog.ts'
import { DEFAULT_REQUEST, OLLAMA_BASE, parseRequest } from './ollama.ts'
import type { Settings } from './settings.ts'

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

/**
 * 써 보기 전에도 알고 있는 모델별 90분 요약 크레딧: 요약 모델 비교 2차(9/29, 강의 2~4개의 토큰 × 단가를 90분으로 환산한 평균).
 * 나머지는 써 본 기록, 그것도 없으면 단가표로 어림한다(llmcatalog.ts).
 */
const KNOWN_CREDITS_PER_90MIN: Record<string, number> = {
  'gpt-6-luna': 2.9,
  'gemini-3.8-flash': 15.5,
  'gpt-6-sol': 49,
  'claude-sonnet-5-5': 88,
  'grok-4-1-fast': 3.5,
  'solar-pro4': 5.9,
  'deepseek-v4-flash': 5.4,
  'claude-haiku-4-5-20251001': 38,
  'gemini-3.1-pro-preview': 44,
  'seed-2-0-lite-260428': 10.7,
  'google/gemma-4-31B-it': 2.4,
  'gemini-3.5-flash-lite': 7.5
}

/**
 * 모델별 90분 요약 크레딧: 끝난 작업의 기록을 90분으로 환산한 평균, 기록이 없으면 알려진 값.
 * 9/29 전 기록(source 없음, 잔액 차이)은 늦은 차감이 섞여 틀어진 것이 있어 쓰지 않는다.
 */
export function creditsPer90ByModel(jobs: Job[]): Record<string, number> {
  const sums: Record<string, { total: number; n: number }> = {}
  for (const j of jobs) {
    const model = j.settings.llm?.model
    const used = j.cost?.source ? j.cost.summaryCredits : null
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

/** 요약 서비스가 제공하는 글 모델 목록. 목록 주소가 없는 서비스는 권장 모델만. */
export async function listModels(id: ProviderId, apiKey: string): Promise<ModelItem[]> {
  const url = PRESETS[id]?.models
  if (!url) return PRESETS[id] ? [{ id: PRESETS[id].model, owner: null }] : []
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
    model: 'gpt-6-luna'
  }
}

export const OLLAMA_NAME = '로컬 LLM'

/**
 * 지금 설정에서 단계마다(요약·전사문 다듬기) 부를 서비스와 모델. 화면 표시와 작업 만들기가 모두 이것을 본다.
 * connected는 요약 서비스(settings.provider)의 키가 있는지. 로컬 LLM은 모델을 골랐으면 쓴다(켜져 있는지는 부를 때 안다).
 */
export function resolveSteps(s: Settings, connected: boolean): { summary: LlmSettings | null; polish: LlmSettings | null } {
  const preset = connected && s.provider ? PRESETS[s.provider] : undefined
  const service = (model: string | null | undefined): LlmSettings | null =>
    preset && model ? { service: s.provider!, endpoint: preset.endpoint, model, creditsUrl: preset.credits } : null
  const local = (step: 'summary' | 'polish'): LlmSettings | null => {
    const model = s.ollama[`${step}Model`]
    const request = s.ollama[`${step}Request`]
    return model ? { service: 'ollama', endpoint: `${OLLAMA_BASE}/api/chat`, model, ollama: request ? parseRequest(request) : DEFAULT_REQUEST[step] } : null
  }
  return {
    summary: s.ollama.summary ? local('summary') : service(s.summaryModel ?? preset?.model),
    polish: s.ollama.polish ? local('polish') : service(s.polishModel)
  }
}
