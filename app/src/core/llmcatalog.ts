// ChatKHU 요약 모델 목록: 글 모델만 거르고, 단가표로 90분 강의 요약 1회의 크레딧을 어림하고, 추천 목록을 정한다.
// 단가: https://docs.mindlogic.ai/docs/khu/baze/product/model-credits (2026-09-16 기준, 크레딧 / 1K 토큰)

export type ModelItem = { id: string; owner: string | null }

/** 모델 목록 응답에서 요약에 쓸 수 있는 글 모델만 뽑는다. OpenAI 형식({ data: [{ id, type }] })과 이름 배열을 모두 받는다. */
export function parseModelList(data: unknown): ModelItem[] {
  const items = Array.isArray(data) ? data : ((data as { data?: unknown; models?: unknown })?.data ?? (data as { models?: unknown })?.models)
  if (!Array.isArray(items)) return []
  const out = new Map<string, ModelItem>()
  for (const m of items) {
    if (typeof m === 'string') {
      if (m) out.set(m, { id: m, owner: null })
      continue
    }
    const o = m as { id?: unknown; name?: unknown; type?: unknown; owned_by?: unknown }
    const id = typeof o?.id === 'string' ? o.id : typeof o?.name === 'string' ? o.name : null
    // 이미지·영상·음성 모델(type: image/video/audio)은 요약에 쓸 수 없다
    if (!id || (o.type !== undefined && o.type !== 'llm')) continue
    if (!out.has(id)) out.set(id, { id, owner: typeof o.owned_by === 'string' ? o.owned_by : null })
  }
  return [...out.values()]
}

/** 모델별 단가 (크레딧 / 1K 토큰). 목록에 있어도 여기 없으면 예상 크레딧을 모른다. */
export const PRICES: Record<string, { input: number; output: number }> = {
  'gpt-6-sol': { input: 2, output: 10 },
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'gpt-5.6-sol': { input: 4, output: 20 },
  'gpt-5.6-terra': { input: 2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2 },
  'gpt-5.5': { input: 5, output: 30 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'gemini-3.1-pro-preview': { input: 2, output: 12 },
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'gemini-3.7-flash': { input: 0.75, output: 3.75 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75 },
  'gemini-3.5-flash': { input: 1.5, output: 9 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'google/gemma-4-31B-it': { input: 0.13, output: 0.38 },
  'muse-spark-1.3': { input: 1.25, output: 4.25 },
  'grok-4.6': { input: 2, output: 6 },
  'grok-4.5': { input: 2, output: 6 },
  'grok-4-1-fast': { input: 0.2, output: 0.5 },
  'solar-pro4': { input: 0.3, output: 1.2 },
  'qwen3.8-max': { input: 2, output: 6 },
  'qwen3.7-max': { input: 1.25, output: 3.75 },
  'qwen3.7-plus': { input: 0.32, output: 1.28 },
  'deepseek-v4-pro': { input: 2.4, output: 4.8 },
  'deepseek-v4-flash': { input: 0.2, output: 0.4 },
  'kimi-k3': { input: 3, output: 15 },
  'glm-5.2': { input: 1.4, output: 4.4 },
  'glm-5.3': { input: 1.4, output: 4.4 },
  'glm-5.3-flash': { input: 0.15, output: 0.5 },
  'seed-2-0-pro-260328': { input: 0.5, output: 3 },
  'seed-2-0-lite-260428': { input: 0.25, output: 2 },
  'sonar-pro': { input: 3, output: 15 },
  'sonar-reasoning-pro': { input: 2, output: 8 }
}

/**
 * 90분 강의 요약 1회의 토큰 수(어림). 임시값: S2의 gemini-3.8-flash 실측(90분 약 12크레딧)에 맞췄다.
 * 모델 비교 측정(cli llm bench)의 토큰 수로 바꾼다. 모델마다 출력 길이·추론 토큰이 달라 어림일 뿐이다.
 */
export const TOKENS_PER_90MIN = { input: 10_000, output: 1_200 }

/**
 * 응답의 토큰 수 × 단가로 계산한 크레딧. 요약 모델 비교 1차에서 7개 모델 모두 실제 차감과 소수 둘째 자리까지 맞았다.
 * 단가나 토큰 수를 모르면 null.
 */
export function creditsFromTokens(id: string, inputTokens: unknown, outputTokens: unknown): number | null {
  const p = PRICES[id]
  if (!p || typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return null
  return Math.round(((inputTokens * p.input + outputTokens * p.output) / 1000) * 100) / 100
}

/** 요약 뒤 교정 검증과 전사문 다듬기의 기본 모델 (9/30 실험: 싸고, 교정 판정이 정확했다) */
export const DEFAULT_STEP_MODEL = 'gpt-6-luna'

/**
 * 90분 강의 1회의 토큰 수: 9/30 gpt-6-luna 실측을 90분으로 환산. 다듬기는 전사 전체를 다시 써서 출력이 길다(추론 포함).
 * 다른 모델은 이 토큰 수 × 단가로 어림한다.
 */
export const STEP_TOKENS_PER_90MIN = { verify: { input: 1_200, output: 600 }, polish: { input: 26_000, output: 35_000 } }

/** 교정 검증·전사문 다듬기 한 번의 90분 강의 크레딧(어림). 단가를 모르면 null. */
export function estimateStepCredits90(step: keyof typeof STEP_TOKENS_PER_90MIN, id: string): number | null {
  const p = PRICES[id]
  const t = STEP_TOKENS_PER_90MIN[step]
  if (!p) return null
  return Math.round(((t.input * p.input + t.output * p.output) / 1000) * 10) / 10
}

/** 단가표로 어림한 90분 강의 요약 1회의 크레딧. 단가를 모르면 null. */
export function estimateCredits90(id: string): number | null {
  const p = PRICES[id]
  if (!p) return null
  return Math.round(((TOKENS_PER_90MIN.input * p.input + TOKENS_PER_90MIN.output * p.output) / 1000) * 10) / 10
}

/**
 * 요약 모델 추천 순서 (9/29 2차 비교, docs/decisions.md). 앞의 RECOMMENDED_COUNT개가 설정의 "추천 모델 목록",
 * 전체가 [전체 모델 보기]. 여기 없는 모델(시간 초과가 잦은 모델 등)은 [직접 모델 입력]으로만 고른다.
 */
export const RANKED: { id: string; note: string }[] = [
  { id: 'gpt-6-luna', note: '요약이 자세하고 크레딧이 적게 들어요' },
  { id: 'gemini-3.8-flash', note: '받아쓰기 오류를 많이 고쳐요' },
  { id: 'gpt-6-sol', note: '요약·교정이 정확하지만 크레딧이 많이 들어요' },
  { id: 'claude-sonnet-5-5', note: '요약이 자세하지만 크레딧이 많이 들어요' },
  { id: 'grok-4-1-fast', note: '빠르고 크레딧이 적게 들어요' },
  { id: 'solar-pro4', note: '' },
  { id: 'deepseek-v4-flash', note: '' },
  { id: 'claude-haiku-4-5-20251001', note: '' },
  { id: 'gemini-3.1-pro-preview', note: '' },
  { id: 'seed-2-0-lite-260428', note: '' },
  { id: 'google/gemma-4-31B-it', note: '' },
  { id: 'gemini-3.5-flash-lite', note: '' }
]

export const RECOMMENDED_COUNT = 5
