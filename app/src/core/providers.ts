// 요약 공급자 프리셋. 엔드포인트는 전체 URL로 둔다 (ChatKHU는 문서대로 끝에 /를 붙인다).
// OpenAI·Gemini는 OpenAI 호환 주소로, Claude는 네이티브 /v1/messages(anthropic.ts)로 부른다. 로컬 LLM(Ollama)은 키로 연결하는 서비스가 아니라 단계마다 고르는 것이다(resolveSteps).
import * as credits from './credits.ts'
import { EngineError } from './errors.ts'
import type { Job, LlmSettings } from './job.ts'
import { anthropicHeaders } from './anthropic.ts'
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
  { id: 'openai', name: 'OpenAI', available: true, keyGuideUrl: 'https://platform.openai.com/api-keys' },
  { id: 'claude', name: 'Claude', available: true, keyGuideUrl: 'https://platform.claude.com/settings/keys' },
  { id: 'gemini', name: 'Gemini', available: true, keyGuideUrl: 'https://aistudio.google.com/apikey' }
]

/** 크레딧으로 쓰는 서비스인가 (잔액·예상 크레딧·남은 요약 횟수를 보인다). 나머지는 작업의 토큰 수만 남긴다. 10/2 전 작업은 service가 없다(ChatKHU) */
export function usesCredits(service: string | null | undefined): boolean {
  return (service ?? 'chatkhu') === 'chatkhu'
}

/** 서비스별 인증 헤더: Claude만 x-api-key, 나머지는 Bearer */
export function authHeaders(id: string, apiKey: string): Record<string, string> {
  return id === 'claude' ? anthropicHeaders(apiKey) : headers(apiKey)
}

// 모델 목록에서 글 모델만 남긴다 (OpenAI·Gemini 목록에는 임베딩·음성·이미지 모델이 섞여 있다)
const TEXT_MODEL: Record<string, (id: string) => boolean> = {
  openai: (id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/audio|realtime|tts|transcribe|image|embedding|search|moderation|instruct/.test(id),
  gemini: (id) => /^gemini-/.test(id) && !/embedding|image|tts|audio|live/.test(id)
}

/** 90분 강의 요약 1회의 크레딧. S2 실측(63분, turbo 전사 7.3~9.3크레딧)을 90분으로 환산했다. */
export const CREDITS_PER_90MIN_SUMMARY = 12

/**
 * 써 보기 전에도 알고 있는 모델별 90분 요약 크레딧: 강의 2~4개의 토큰 × 단가를 90분으로 환산한 평균.
 * luna·flash·sol·grok·deepseek·gemma는 주제별 틀로 바꾼 뒤(10/2), 나머지는 그 전(9/29 2차 비교)에 잰 값이라 조금 낮게 본다.
 * 나머지는 써 본 기록, 그것도 없으면 단가표로 어림한다(llmcatalog.ts).
 */
const KNOWN_CREDITS_PER_90MIN: Record<string, number> = {
  'gpt-6-luna': 3.9,
  'gemini-3.8-flash': 17.4,
  'gpt-6.1-sol': 65,
  'gpt-6-sol': 49,
  'claude-sonnet-5-5': 88,
  'grok-4-1-fast': 3.9,
  'solar-pro4': 5.9,
  'deepseek-v4-flash': 6.8,
  'claude-haiku-4-5-20251001': 38,
  'gemini-3.1-pro-preview': 44,
  'seed-2-0-lite-260428': 10.7,
  'google/gemma-4-31B-it': 2.7,
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
  const resp = await request(url, { headers: authHeaders(id, apiKey) }, 15_000, '모델 목록')
  await raiseForStatus(resp, '모델 목록')
  const data = await resp.json()
  if (id === 'chatkhu') return parseModelList(data)
  // OpenAI 형식 { data: [{ id }] } (Claude도 같다). Gemini는 이름 앞에 models/가 붙어 오기도 한다
  const items = (data as { data?: { id?: unknown }[] })?.data ?? []
  const keep = TEXT_MODEL[id] ?? (() => true)
  const ids = items.map((m) => (typeof m?.id === 'string' ? m.id.replace(/^models\//, '') : '')).filter((m) => m && keep(m))
  return [...new Set(ids)].map((m) => ({ id: m, owner: null }))
}

/** 키를 확인한다. 잔액을 볼 수 있는 서비스(ChatKHU)는 남은 크레딧을 돌려준다. 요금이 드는 호출은 하지 않는다. */
export async function verifyKey(id: ProviderId, apiKey: string): Promise<{ credits: number | null }> {
  if (id === 'chatkhu') return { credits: credits.remaining(await credits.get(PRESETS['chatkhu'].credits!, apiKey)) }
  if (!PRESETS[id]) throw new EngineError('input', '아직 지원하지 않는 요약 서비스예요.')
  // 잔액을 볼 수 없는 서비스는 모델 목록을 받아 키만 확인한다
  await listModels(id, apiKey)
  return { credits: null }
}

export type Preset = { endpoint: string; credits?: string; models?: string; model: string }

export const PRESETS: Record<string, Preset> = {
  chatkhu: {
    endpoint: `${CHATKHU_BASE}/chat/completions/`,
    credits: `${CHATKHU_BASE}/credits/`,
    models: `${CHATKHU_BASE}/models/`,
    model: 'gpt-6-luna'
  },
  // 아래 셋의 기본 모델은 서비스마다 빠르고 싼 등급이다. 연결할 때 목록에 없으면 목록의 첫 모델을 쓴다(main의 llm.connect)
  openai: { endpoint: 'https://api.openai.com/v1/chat/completions', models: 'https://api.openai.com/v1/models', model: 'gpt-6-luna' },
  claude: { endpoint: 'https://api.anthropic.com/v1/messages', models: 'https://api.anthropic.com/v1/models?limit=1000', model: 'claude-haiku-4-5' },
  gemini: {
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    models: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
    model: 'gemini-3.8-flash'
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
