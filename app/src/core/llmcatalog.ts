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

/** 단가표로 어림한 90분 강의 요약 1회의 크레딧. 단가를 모르면 null. */
export function estimateCredits90(id: string): number | null {
  const p = PRICES[id]
  if (!p) return null
  return Math.round(((TOKENS_PER_90MIN.input * p.input + TOKENS_PER_90MIN.output * p.output) / 1000) * 10) / 10
}

export type FeaturedGroup = '권장' | '더 싸게' | '더 좋게'

/** 설정에 먼저 보이는 추천 목록 (9/29). 나머지는 [전체 모델 보기]에서 고른다. */
export const FEATURED: { id: string; group: FeaturedGroup; note: string }[] = [
  { id: 'gemini-3.8-flash', group: '권장', note: '교정이 보수적이고 정확해요 (S2 실측)' },
  { id: 'gpt-6-luna', group: '더 싸게', note: '가장 싼 편이에요' },
  { id: 'solar-pro4', group: '더 싸게', note: '국내 모델 (Upstage)' },
  { id: 'gemini-3.5-flash-lite', group: '더 싸게', note: '교정에서 잘못 바꾸는 경우가 있어요 (S2 실측)' },
  { id: 'gpt-6-sol', group: '더 좋게', note: '' },
  { id: 'claude-sonnet-5', group: '더 좋게', note: '' },
  { id: 'gemini-3.1-pro-preview', group: '더 좋게', note: '' }
]
