// 전사문 다듬기: 정리된 전사를 약 2000자 조각으로 나눠 LLM이 오인식만 고쳐 다시 쓰게 한다 (선택 기능, 기본은 꺼짐).
// 예전 파이프라인의 로컬 LLM 교정 단계를 옮긴 것이다. 9/30 실험(docs/decisions.md): 교정 목록보다 훨씬 많이 고치지만
// 90분에 약 20크레딧(gpt-6-luna)이 들고, 말하지 않은 내용을 넣거나 빼는 경우가 있다. 그래서 원문 정리본을 노트에 함께 남긴다.
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Paragraph } from './clean.ts'
import { EngineError } from './errors.ts'
import { readJson, writeJsonAtomic } from './files.ts'
import { chat } from './llm.ts'
import type { ChatOptions, Message, Usage } from './llm.ts'
import type { OllamaRequest } from './ollama.ts'
import { POLISH_TRANSCRIPT } from './prompts.ts'

const CHUNK_CHARS = 2000 // 예전 파이프라인의 chunk_size_chars
const PREV_TAIL_CHARS = 200
const CONCURRENCY = 4
// 조각의 문단 수가 달라지거나 길이가 이 범위를 벗어나면 그 조각은 다듬지 않은 원문을 쓴다 (내용을 빼거나 지어낸 것으로 본다)
const MIN_RATIO = 0.85
const MAX_RATIO = 1.2
// 조각을 동시에 보내다 분당 한도(429)에 걸리면 그 조각만 기다렸다 다시 보낸다 (낮은 등급 키는 한도가 작다)
const RATE_LIMIT_WAITS_MS = [5000, 20_000]

async function chatWithRetry(o: PolishOptions, messages: Message[], options: ChatOptions, waits = RATE_LIMIT_WAITS_MS): Promise<[string, Usage | null]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await chat(o.endpoint, o.apiKey, o.model, messages, options)
    } catch (e) {
      if (!(e instanceof EngineError) || e.code !== 'rate_limit' || attempt >= waits.length) throw e
      await new Promise((r) => setTimeout(r, waits[attempt]))
    }
  }
}

export type PolishOptions = {
  endpoint: string
  apiKey: string | null
  model: string
  /** 서비스 id (호출 형식이 서비스마다 다르다, llm.ts의 chat) */
  service?: string
  /** 있으면 로컬 LLM(Ollama)으로 다듬는다. 한 번에 한 조각씩 보낸다 (동시에 보내면 Ollama가 줄을 세우거나 컨텍스트 메모리를 배로 쓴다) */
  ollama?: OllamaRequest
  signal?: AbortSignal
  /** 마지막 조각 뒤 로컬 모델을 메모리에서 내린다 */
  unloadAfter?: boolean
  /** 요청 몰림(429) 때 조각을 다시 보내기 전에 기다릴 시간들 (테스트용) */
  rateLimitWaitsMs?: number[]
  /** 있으면 조각 결과를 이 폴더에 part_NNN.json으로 남기고, 다시 부르면 끝난 조각은 다시 보내지 않는다 (받아쓰기 조각과 같은 방식) */
  resumeDir?: string
}
/** 조각 하나의 결과. key는 주소·모델과 보낸 글의 해시라서, 모델·필기·전사가 바뀌면 다시 보낸다. texts가 null이면 검사에 걸려 원문을 쓴 조각이고,
 * 그때는 왜 걸렸는지(reason)와 모델이 돌려준 글(rejected)을 함께 남긴다 (나중에 들여다볼 수 있게. 노트에는 쓰지 않는다) */
type SavedChunk = { key: string; texts: string[] | null; inputTokens: number; outputTokens: number; reason?: string; rejected?: string }
export type PolishResult = {
  paragraphs: Paragraph[]
  /** 검사에 걸려 원문을 쓴 조각 수 / 전체 조각 수 */
  fallbackChunks: number
  chunks: number
  /** 원문을 쓴 조각마다의 이유 (예: "3번 조각: 문단 수 10 → 9") */
  fallbackReasons: string[]
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
  return rejectReason(input, output) === null
}

/** 다시 쓴 조각을 받아들이지 않는 이유. 받아들이면 null */
export function rejectReason(input: Paragraph[], output: string[]): string | null {
  if (output.length !== input.length) return `문단 수 ${input.length} → ${output.length}`
  const ratio = output.join('').length / Math.max(1, input.map((p) => p.text).join('').length)
  return ratio >= MIN_RATIO && ratio <= MAX_RATIO ? null : `길이 ${ratio.toFixed(2)}배`
}

export async function polishParagraphs(paras: Paragraph[], notes: string, o: PolishOptions): Promise<PolishResult> {
  const chunks = chunkParagraphs(paras)
  const requests = chunks.map((chunk, i) => {
    let system = POLISH_TRANSCRIPT
    if (notes) system += `\n\n[필기노트]\n${notes}`
    if (i > 0) system += `\n\n[이전 청크 마지막 부분 - 참고용, 다시 출력하지 말 것]\n${chunks[i - 1].map((p) => p.text).join('\n\n').slice(-PREV_TAIL_CHARS)}`
    const user = chunk.map((p) => p.text).join('\n\n')
    return { system, user, key: createHash('sha256').update([o.endpoint, o.model, system, user].join('\0')).digest('hex') }
  })
  const fileOf = (i: number): string => join(o.resumeDir!, `part_${String(i).padStart(3, '0')}.json`)
  if (o.resumeDir) await mkdir(o.resumeDir, { recursive: true })
  // 앞선 실행에서 끝낸 조각 (앱이 꺼지거나 실패해 다시 하는 경우)
  const saved: (SavedChunk | null)[] = await Promise.all(
    requests.map(async (r, i) => {
      if (!o.resumeDir) return null
      const s = await readJson<SavedChunk>(fileOf(i)).catch(() => null)
      return s?.key === r.key ? s : null
    })
  )
  const pending = saved.flatMap((s, i) => (s ? [] : [i]))
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < pending.length) {
      const at = next++
      const i = pending[at]
      const [content, usage] = await chatWithRetry(o,
        [{ role: 'system', content: requests[i].system }, { role: 'user', content: requests[i].user }],
        // 로컬은 출력 상한을 조각 길이에 맞춘다 (num_ctx 16K 안에 입력과 함께 들어가야 한다)
        { maxTokens: o.ollama ? 4096 : 16_000, service: o.service, ollama: o.ollama, signal: o.signal, unloadAfter: o.unloadAfter && at === pending.length - 1 },
        o.rateLimitWaitsMs)
      const parts = content.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
      const reason = usage?.['done_reason'] === 'length' ? '출력이 상한에 걸려 끊김' : rejectReason(chunks[i], parts)
      saved[i] = {
        key: requests[i].key,
        texts: reason ? null : parts,
        ...(reason ? { reason, rejected: content } : {}),
        inputTokens: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
        outputTokens: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0
      }
      if (o.resumeDir) await writeJsonAtomic(fileOf(i), saved[i])
    }
  }
  // 한 조각이 실패하면 새 조각은 보내지 않되, 이미 보낸 조각은 끝나 저장될 때까지 기다린 뒤 실패를 알린다
  const runs = await Promise.allSettled(Array.from({ length: Math.min(o.ollama ? 1 : CONCURRENCY, pending.length) }, () => worker().catch((e) => {
    next = pending.length
    throw e
  })))
  const failed = runs.find((r) => r.status === 'rejected')
  if (failed) throw failed.reason
  const done = saved as SavedChunk[]
  return {
    paragraphs: chunks.flatMap((chunk, i) => (done[i].texts ? chunk.map((p, k) => ({ ...p, text: done[i].texts![k] })) : chunk)),
    fallbackChunks: done.filter((s) => !s.texts).length,
    chunks: chunks.length,
    fallbackReasons: done.flatMap((s, i) => (s.texts ? [] : [`${i + 1}번 조각: ${s.reason ?? '이유 기록 없음'}`])),
    // 앞선 실행에서 쓴 토큰도 더한다 (그때도 과금됐다)
    inputTokens: done.reduce((n, s) => n + s.inputTokens, 0),
    outputTokens: done.reduce((n, s) => n + s.outputTokens, 0)
  }
}
