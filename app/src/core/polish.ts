// 전사문 다듬기: 정리된 전사를 약 2000자 조각으로 나눠 LLM이 오인식만 고쳐 다시 쓰게 한다 (선택 기능, 기본은 꺼짐).
// 예전 파이프라인의 로컬 LLM 교정 단계를 옮긴 것이다. 9/30 실험(docs/decisions.md): 교정 목록보다 훨씬 많이 고치지만
// 90분에 약 20크레딧(gpt-6-luna)이 들고, 말하지 않은 내용을 넣거나 빼는 경우가 있다. 그래서 원문 정리본을 노트에 함께 남긴다.
import type { Paragraph } from './clean.ts'
import { chat } from './llm.ts'
import type { OllamaRequest } from './ollama.ts'
import { POLISH_TRANSCRIPT } from './prompts.ts'

const CHUNK_CHARS = 2000 // 예전 파이프라인의 chunk_size_chars
const PREV_TAIL_CHARS = 200
const CONCURRENCY = 4
// 조각의 문단 수가 달라지거나 길이가 이 범위를 벗어나면 그 조각은 다듬지 않은 원문을 쓴다 (내용을 빼거나 지어낸 것으로 본다)
const MIN_RATIO = 0.85
const MAX_RATIO = 1.2

export type PolishOptions = {
  endpoint: string
  apiKey: string | null
  model: string
  /** 있으면 로컬 LLM(Ollama)으로 다듬는다. 한 번에 한 조각씩 보낸다 (동시에 보내면 Ollama가 줄을 세우거나 컨텍스트 메모리를 배로 쓴다) */
  ollama?: OllamaRequest
  signal?: AbortSignal
  /** 마지막 조각 뒤 로컬 모델을 메모리에서 내린다 */
  unloadAfter?: boolean
}
export type PolishResult = {
  paragraphs: Paragraph[]
  /** 검사에 걸려 원문을 쓴 조각 수 / 전체 조각 수 */
  fallbackChunks: number
  chunks: number
  inputTokens: number
  outputTokens: number
}

/** 문단을 순서대로 CHUNK_CHARS 안쪽 조각으로 묶는다 (문단 하나가 더 길면 그 문단만으로 한 조각) */
export function chunkParagraphs(paras: Paragraph[]): Paragraph[][] {
  const chunks: Paragraph[][] = []
  let cur: Paragraph[] = []
  let len = 0
  for (const p of paras) {
    if (cur.length && len + p.text.length > CHUNK_CHARS) {
      chunks.push(cur)
      cur = []
      len = 0
    }
    cur.push(p)
    len += p.text.length + 2
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

/** 다시 쓴 조각을 받아들일지: 문단 수가 같고 전체 길이가 크게 달라지지 않았을 때만 */
export function acceptable(input: Paragraph[], output: string[]): boolean {
  if (output.length !== input.length) return false
  const ratio = output.join('').length / Math.max(1, input.map((p) => p.text).join('').length)
  return ratio >= MIN_RATIO && ratio <= MAX_RATIO
}

export async function polishParagraphs(paras: Paragraph[], notes: string, o: PolishOptions): Promise<PolishResult> {
  const chunks = chunkParagraphs(paras)
  const out: Paragraph[][] = new Array(chunks.length)
  let fallbackChunks = 0
  let inputTokens = 0
  let outputTokens = 0
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < chunks.length) {
      const i = next++
      let system = POLISH_TRANSCRIPT
      if (notes) system += `\n\n[필기노트 용어집]\n${notes}`
      if (i > 0) system += `\n\n[이전 청크 마지막 부분 - 참고용, 다시 출력하지 말 것]\n${chunks[i - 1].map((p) => p.text).join('\n\n').slice(-PREV_TAIL_CHARS)}`
      const [content, usage] = await chat(o.endpoint, o.apiKey, o.model,
        [{ role: 'system', content: system }, { role: 'user', content: chunks[i].map((p) => p.text).join('\n\n') }],
        // 로컬은 출력 상한을 조각 길이에 맞춘다 (num_ctx 16K 안에 입력과 함께 들어가야 한다)
        { maxTokens: o.ollama ? 4096 : 16_000, ollama: o.ollama, signal: o.signal, unloadAfter: o.unloadAfter && i === chunks.length - 1 })
      inputTokens += typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0
      outputTokens += typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0
      const parts = content.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
      if (usage?.['done_reason'] !== 'length' && acceptable(chunks[i], parts)) out[i] = chunks[i].map((p, k) => ({ ...p, text: parts[k] }))
      else {
        out[i] = chunks[i]
        fallbackChunks++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(o.ollama ? 1 : CONCURRENCY, chunks.length) }, worker))
  return { paragraphs: out.flat(), fallbackChunks, chunks: chunks.length, inputTokens, outputTokens }
}
