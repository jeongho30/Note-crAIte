// ChatKHU 요약 모델 목록: 글 모델만 거르고, 단가표로 90분 강의 요약 1회의 크레딧을 어림하고, 추천 목록을 정한다.
// 단가·추천 순서는 modelcatalog.json(카탈로그)에 있다. 앱에 든 것이 기본이고, 메인이 저장소의 새 것을 받아 바꾼다(catalogsync.ts).
import builtin from './modelcatalog.json' with { type: 'json' }

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

/**
 * 모델 카탈로그 (modelcatalog.json). 새 모델이 나오면 이 파일만 고쳐 main에 올리면 설치된 앱에도 반영된다.
 * - prices: 모델별 단가 (크레딧 / 1K 토큰). 목록에 있어도 여기 없으면 예상 크레딧을 모른다.
 *   https://docs.mindlogic.ai/docs/khu/baze/product/model-credits (2026-09-16 기준. gpt-6.1-sol만 2026-09-30 기준 문서에서 더함)
 * - ranked: 요약 모델 추천 순서 (9/29 2차 비교와 10/2 다시 비교, docs/decisions.md). 앞의 recommendedCount개가 설정의 "추천 모델 목록",
 *   전체가 [전체 모델 보기].
 *   10/2: gpt-6-sol 자리에 gpt-6.1-sol(잰 것 중 요약이 가장 빠짐없고 교정을 하나도 망가뜨리지 않음). deepseek-v4-flash(틀린 서술이 가장 많고
 *   출력이 길어 상한에 걸림)와 gemma(수식이 깨지고 교정을 자주 망가뜨림)는 맨 뒤로 내렸다. grok-4-1-fast는 요약이 가장 짧고 담는 내용이
 *   가장 적어 추천에서 뺐다(추천은 4개). 10/2에 다시 잰 것은 luna·flash·sol·grok·deepseek·gemma뿐이다.
 * - polishRecommended: 전사문 다듬기 추천 모델. 90분 약 20크레딧 안팎인 모델. 10/2 작성자 결정으로 grok-4-1-fast와 deepseek-v4-flash를 뺐다
 *   ([전체 모델 보기]에서는 고를 수 있다). 다듬기 품질을 재 본 것은 gpt-6-luna와 로컬 gemma 12B뿐이다(docs/decisions.md).
 * - hidden: 알지만 목록에 보이지 않는 모델(시간 초과가 잦은 모델 등). [직접 모델 입력]으로만 고른다.
 *   ranked에도 hidden에도 없는 모델이 서비스 목록에 있으면 새로 나온 모델로 보고 [전체 모델 보기] 끝에 보인다(newModels).
 * - summaryCredits90: 써 보기 전에도 알고 있는 모델별 90분 요약 크레딧: 강의 2~4개의 토큰 × 단가를 90분으로 환산한 평균.
 *   luna·flash·sol·grok·deepseek·gemma는 주제별 틀로 바꾼 뒤(10/2), 나머지는 그 전(9/29 2차 비교)에 잰 값이라 조금 낮게 본다.
 * - updated: 고친 날짜(YYYY-MM-DD). 받아 온 것이 앱에 든 것보다 오래됐으면 쓰지 않는다.
 * 형식을 바꿔야 하면 version을 올리지 말고 새 파일 이름으로 낸다(옛 앱은 이 주소의 version 1만 읽는다).
 */
export type Catalog = {
  version: 1
  updated: string
  prices: Record<string, { input: number; output: number }>
  ranked: { id: string; note: string }[]
  recommendedCount: number
  polishRecommended: string[]
  hidden: string[]
  summaryCredits90: Record<string, number>
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 받아 온 카탈로그를 확인한다. 하나라도 형식이 다르면 null (반쯤 맞는 카탈로그로 단가를 잘못 보이지 않게). 모르는 필드는 버린다. */
export function parseCatalog(data: unknown): Catalog | null {
  if (!isRecord(data) || data['version'] !== 1) return null
  const { updated, prices, ranked, recommendedCount, polishRecommended, hidden, summaryCredits90 } = data
  if (typeof updated !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(updated)) return null
  if (!isRecord(prices) || !isRecord(summaryCredits90)) return null
  if (!Array.isArray(ranked) || !Array.isArray(polishRecommended) || !Array.isArray(hidden)) return null
  const priceOut: Catalog['prices'] = {}
  for (const [id, p] of Object.entries(prices)) {
    if (!isId(id) || !isRecord(p) || !isAmount(p['input']) || !isAmount(p['output'])) return null
    priceOut[id] = { input: p['input'], output: p['output'] }
  }
  const rankedOut: Catalog['ranked'] = []
  for (const r of ranked) {
    if (!isRecord(r) || !isId(r['id']) || typeof r['note'] !== 'string' || r['note'].length > 100) return null
    if (!rankedOut.some((x) => x.id === r['id'])) rankedOut.push({ id: r['id'], note: r['note'] })
  }
  if (!rankedOut.length || !Number.isInteger(recommendedCount) || (recommendedCount as number) < 1 || (recommendedCount as number) > rankedOut.length) return null
  if (!polishRecommended.every(isId) || !hidden.every(isId)) return null
  for (const [id, v] of Object.entries(summaryCredits90)) if (!isId(id) || !isAmount(v)) return null
  return {
    version: 1,
    updated,
    prices: priceOut,
    ranked: rankedOut,
    recommendedCount: recommendedCount as number,
    polishRecommended: [...polishRecommended],
    hidden: [...hidden],
    summaryCredits90: { ...(summaryCredits90 as Record<string, number>) }
  }
}

/** 앱에 든 카탈로그 */
export const BUILTIN: Catalog = parseCatalog(builtin)!

let current = BUILTIN

/** 지금 쓰는 카탈로그: 앱에 든 것, 또는 메인이 받아 온 더 새 것 */
export function catalog(): Catalog {
  return current
}

export function setCatalog(c: Catalog): void {
  current = c
}

/**
 * 서비스의 글 모델 중 카탈로그가 모르는 것(추천 순서에도 숨김 목록에도 없음): 카탈로그를 고친 뒤에 나온 모델이다.
 * 비교해 보지 않았어도 바로 고를 수 있게 [전체 모델 보기] 끝에 보인다. 단가를 모르면 예상 크레딧은 비고, 써 보면 기록으로 채워진다.
 */
export function newModels(available: string[]): string[] {
  const known = new Set([...current.ranked.map((r) => r.id), ...current.hidden])
  return [...new Set(available)].filter((id) => !known.has(id))
}

/**
 * 90분 강의 요약 1회의 토큰 수(어림). 주제별 틀로 바꾼 뒤의 10/2 비교(강의 4개, 6개 모델, 44회)를 90분으로 맞춘 중앙값
 * (입력 17,076, 출력 2,282)이다. 모델마다 달라 어림일 뿐이다: 출력은 grok 760부터 추론이 긴 deepseek 6,000까지,
 * Claude는 입력이 약 2배(9/29). 틀을 바꾸기 전(9/29, 62회)의 중앙값은 입력 14,835, 출력 1,734였다.
 */
export const TOKENS_PER_90MIN = { input: 17_000, output: 2_300 }

/**
 * 응답의 토큰 수 × 단가로 계산한 크레딧. 요약 모델 비교 1차에서 7개 모델 모두 실제 차감과 소수 둘째 자리까지 맞았다.
 * 단가나 토큰 수를 모르면 null.
 */
export function creditsFromTokens(id: string, inputTokens: unknown, outputTokens: unknown): number | null {
  const p = current.prices[id]
  if (!p || typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return null
  return Math.round(((inputTokens * p.input + outputTokens * p.output) / 1000) * 100) / 100
}

/** 요약 뒤 교정 검증과 전사문 다듬기의 기본 모델 (9/30 실험: 싸고, 교정 판정이 정확했다) */
export const DEFAULT_STEP_MODEL = 'gpt-6-luna'

/**
 * 90분 강의 1회의 토큰 수: 9/30 gpt-6-luna 실측을 90분으로 환산. 다듬기는 전사 전체를 다시 써서 출력이 길다(추론 포함).
 * 다듬기는 전사 품질 실험(강의 6번, 90분 환산 21~38크레딧)에 맞춰 luna 약 30크레딧이 되게 잡았다. 말이 빠른 강의일수록 더 든다.
 * 다른 모델은 이 토큰 수 × 단가로 어림한다.
 */
export const STEP_TOKENS_PER_90MIN = { verify: { input: 1_200, output: 600 }, polish: { input: 39_000, output: 52_200 } }

/** 교정 검증·전사문 다듬기 한 번의 90분 강의 크레딧(어림). 단가를 모르면 null. */
export function estimateStepCredits90(step: keyof typeof STEP_TOKENS_PER_90MIN, id: string): number | null {
  const p = current.prices[id]
  const t = STEP_TOKENS_PER_90MIN[step]
  if (!p) return null
  return Math.round(((t.input * p.input + t.output * p.output) / 1000) * 10) / 10
}

/** 단가표로 어림한 90분 강의 요약 1회의 크레딧. 단가를 모르면 null. */
export function estimateCredits90(id: string): number | null {
  const p = current.prices[id]
  if (!p) return null
  return Math.round(((TOKENS_PER_90MIN.input * p.input + TOKENS_PER_90MIN.output * p.output) / 1000) * 10) / 10
}
