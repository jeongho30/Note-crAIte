// STT 결과를 코드 규칙으로 정리한다: 반복 루프 잔여와 환각 문장을 지우고 문단으로 묶는다.
//
// 규칙은 실제 전사로 정했다. 작은 모델(small)에서만 같은 단어·구절이 수십 번 반복되는 루프가 나왔고
// ("C C C C", "C제공을 많이 구해요" x12), 흔한 환각 문장은 나오지 않았다 (docs/decisions.md S3).
import type { Segment } from './stt/base.ts'

// 구간 전체가 이 문장과 같을 때만 지운다 (띄어쓰기·문장부호 무시). 실제 발화를 지우지 않도록 짧게 유지한다.
// 기존 강의 전사 20개(large-v3 + VAD)에는 이런 문장이 없었다. 작은 모델이 무음 구간에서 만들 수 있는 것만 둔다.
const HALLUCINATIONS_KO = [
  '시청해 주셔서 감사합니다',
  '구독과 좋아요 부탁드립니다',
  '구독과 좋아요 그리고 알림 설정 부탁드립니다',
  '다음 영상에서 만나요',
  'MBC 뉴스 이덕영입니다'
]

const PUNCT_RE = /[\s.,!?~…·'"]/g

export type Paragraph = Segment
export type CleanStats = { segmentsIn: number; loopsCollapsed: number; hallucinationsRemoved: number; repeatsRemoved: number }
export type Cleaned = { paragraphs: Paragraph[]; stats: CleanStats }

function key(text: string): string {
  return text.replace(PUNCT_RE, '')
}

const HALLUCINATION_KEYS = new Set(HALLUCINATIONS_KO.map(key))

function sameTokens(tokens: string[], at: number, gram: string[]): boolean {
  return gram.every((t, k) => tokens[at + k] === t)
}

/** 같은 단어·구절(1~maxN 어절)이 minRun번 이상 연달아 나오면 한 번만 남긴다. "네 네 네"는 그대로 둔다. */
export function collapseTokenLoops(text: string, minRun = 4, maxN = 3): string {
  let tokens = text.split(/\s+/).filter(Boolean)
  for (let n = 1; n <= maxN; n++) {
    const out: string[] = []
    let i = 0
    while (i < tokens.length) {
      const gram = tokens.slice(i, i + n)
      let run = 1
      while (i + (run + 1) * n <= tokens.length && sameTokens(tokens, i + run * n, gram)) run++
      if (gram.length === n && run >= minRun) {
        out.push(...gram)
        i += run * n
      } else {
        out.push(tokens[i])
        i++
      }
    }
    tokens = out
  }
  return tokens.join(' ')
}

export function clean(segments: Segment[], gapMs = 2000, maxChars = 400): Cleaned {
  const stats: CleanStats = { segmentsIn: segments.length, loopsCollapsed: 0, hallucinationsRemoved: 0, repeatsRemoved: 0 }

  const items: { seg: Segment; key: string }[] = []
  for (const seg of segments) {
    const text = seg.text.trim()
    const collapsed = collapseTokenLoops(text)
    if (collapsed !== text) stats.loopsCollapsed++
    const k = key(collapsed)
    if (!k) continue
    if (HALLUCINATION_KEYS.has(k)) {
      stats.hallucinationsRemoved++
      continue
    }
    items.push({ seg: { ...seg, text: collapsed }, key: k })
  }

  const kept: Segment[] = []
  for (let i = 0; i < items.length; ) {
    let j = i
    while (j + 1 < items.length && items[j + 1].key === items[i].key) j++
    const run = j - i + 1
    // 같은 문장이 연달아 3번 이상이면 반복 루프로 보고 하나만 남긴다 (2번까지는 실제 발화일 수 있음)
    const group = run >= 3 ? [items[i].seg] : items.slice(i, j + 1).map((it) => it.seg)
    stats.repeatsRemoved += run - group.length
    kept.push(...group)
    i = j + 1
  }

  const paragraphs: Paragraph[] = []
  for (const seg of kept) {
    const last = paragraphs.at(-1)
    if (last && seg.startMs - last.endMs < gapMs && last.text.length < maxChars) {
      last.text += ' ' + seg.text
      last.endMs = seg.endMs
    } else {
      paragraphs.push({ startMs: seg.startMs, endMs: seg.endMs, text: seg.text })
    }
  }
  return { paragraphs, stats }
}

export function transcriptText(cleaned: Cleaned): string {
  return cleaned.paragraphs.map((p) => p.text).join('\n\n')
}
