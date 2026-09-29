// 요약 호출이 돌려준 "오인식 → 정정" 목록을 전사문에 적용한다 (API 통합 모드).
// 전사문 전체를 LLM이 다시 쓰게 하면 출력 비용이 크므로, 짧은 목록만 받아 코드가 치환한다.

export const MAX_ITEMS = 40

const LETTER_RE = /[A-Za-z가-힣]/
const ASCII_WORD_RE = /[A-Za-z0-9]/
const HANGUL_RE = /[가-힣]/

export type Correction = { wrong: string; right: string }
export type AppliedCorrection = Correction & { count: number }

/**
 * 전사에 실제로 있고, 2자 이상이며, 정정어와 다른 항목만 최대 MAX_ITEMS개 고른다.
 * 실제 강의로 본 오치환(S2)도 막는다: 숫자·기호만인 표현("80→Parsing"), 대소문자만 바꾸는 교정.
 */
export function select(corrections: unknown[], text: string): Correction[] {
  const picked: Correction[] = []
  const seen = new Set<string>()
  for (const c of corrections) {
    if (typeof c !== 'object' || c === null || Array.isArray(c)) continue
    const item = c as { wrong?: unknown; right?: unknown }
    const wrong = String(item.wrong ?? '').trim()
    const right = String(item.right ?? '').trim()
    if (wrong.length < 2 || !right || wrong.toLowerCase() === right.toLowerCase() || seen.has(wrong)) continue
    if (!LETTER_RE.test(wrong) || !text.includes(wrong)) continue
    seen.add(wrong)
    picked.push({ wrong, right })
    if (picked.length === MAX_ITEMS) break
  }
  return picked
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pattern(wrong: string): string {
  // 영문·숫자로 시작하거나 끝나면 단어 경계를 지킨다 ("IDE"가 "IDEA" 안에서 바뀌지 않게).
  // 한글로 시작하면 앞쪽 경계만 지킨다 ("터미널"이 "넌터미널" 안에서, "에이"가 "펌츄에이션" 안에서 바뀌지 않게).
  // 뒤쪽은 조사가 바로 붙으므로 두지 않는다. 요약 모델 비교 2차의 교정 판정에서 잘못 바꾼 곳 10곳을 막고 고친 곳은 3곳만 잃었다.
  let p = escapeRegExp(wrong)
  if (ASCII_WORD_RE.test(wrong[0])) p = '(?<![A-Za-z0-9])' + p
  else if (HANGUL_RE.test(wrong[0])) p = '(?<![가-힣])' + p
  if (ASCII_WORD_RE.test(wrong.at(-1)!)) p += '(?![A-Za-z0-9])'
  return p
}

/** 긴 것부터 정규식 하나로 한 번에 치환한다 (치환 결과가 다시 치환되지 않게). 항목별 적용 횟수를 돌려준다. */
export function apply(texts: string[], corrections: Correction[]): [string[], AppliedCorrection[]] {
  if (corrections.length === 0) return [texts, []]
  const items = [...corrections].sort((a, b) => b.wrong.length - a.wrong.length)
  const re = new RegExp(items.map((c) => pattern(c.wrong)).join('|'), 'g')
  const mapping = new Map(items.map((c) => [c.wrong, c.right]))
  const counts = new Map<string, number>()
  const fixed = texts.map((t) =>
    t.replace(re, (m) => {
      counts.set(m, (counts.get(m) ?? 0) + 1)
      return mapping.get(m)!
    })
  )
  const applied = items.filter((c) => counts.has(c.wrong)).map((c) => ({ ...c, count: counts.get(c.wrong)! }))
  applied.sort((a, b) => b.count - a.count)
  return [fixed, applied]
}
