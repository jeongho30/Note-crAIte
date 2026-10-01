import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import { EngineError } from '../src/core/errors.ts'
import { chat } from '../src/core/llm.ts'
import * as ollama from '../src/core/ollama.ts'
import { polishParagraphs } from '../src/core/polish.ts'
import { resolveSteps } from '../src/core/providers.ts'
import { DEFAULT_SETTINGS } from '../src/core/settings.ts'

type Body = Record<string, any>
type Reply = (body: Body, res: ServerResponse) => void | Promise<void>

/** 가짜 Ollama: 받은 요청을 모으고 reply가 정한 대로 답한다 */
async function fake(reply: Reply): Promise<{ endpoint: string; requests: Body[] }> {
  const requests: Body[] = []
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const body = JSON.parse(raw) as Body
    requests.push(body)
    await reply(body, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  after(() => server.close())
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat`, requests }
}

function stream(res: ServerResponse, parts: string[], last: Body = {}): void {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
  for (const p of parts) res.write(JSON.stringify({ message: { role: 'assistant', content: p }, done: false }) + '\n')
  res.end(JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5, ...last }) + '\n')
}

function fail(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error }))
}

const exceed = (prompt: number, ctx: number): string =>
  JSON.stringify({ error: { code: 400, message: 'request exceeds the available context size', type: 'exceed_context_size_error', n_prompt_tokens: prompt, n_ctx: ctx } })

const MESSAGES = [{ role: 'user' as const, content: '안녕' }]

test('요청 옵션: JSON이 아니거나 잠긴 키·잘못된 num_ctx는 거절한다', () => {
  assert.deepEqual(ollama.parseRequest('{"think": false, "options": {"num_ctx": "auto", "temperature": 0.2}}'),
                   { think: false, options: { num_ctx: 'auto', temperature: 0.2 } })
  for (const bad of ['think: false', '[]', '{"model": "x"}', '{"keep_alive": 0}', '{"options": 3}', '{"options": {"num_ctx": "big"}}', '{"options": {"num_ctx": 0}}']) {
    assert.throws(() => ollama.parseRequest(bad), (e: unknown) => e instanceof EngineError && e.code === 'input', bad)
  }
})

test('스트림을 이어 붙이고, 고친 옵션·잘림 금지·출력 상한·스키마·모델 내리기를 요청에 넣는다', async () => {
  const f = await fake((_b, res) => stream(res, ['안녕', '하세요']))
  const schema = { type: 'object' }
  const [text, usage] = await chat(f.endpoint, null, 'm', MESSAGES, {
    maxTokens: 100, ollama: { think: false, options: { num_ctx: 8192, temperature: 0 } }, unloadAfter: true,
    responseFormat: { type: 'json_schema', json_schema: { name: 'x', strict: true, schema } }
  })
  assert.equal(text, '안녕하세요')
  assert.equal(usage?.prompt_tokens, 10)
  assert.equal(usage?.completion_tokens, 5)
  assert.deepEqual(f.requests[0], {
    think: false, model: 'm', messages: MESSAGES, stream: true, truncate: false,
    options: { num_ctx: 8192, temperature: 0, num_predict: 100 }, format: schema, keep_alive: 0
  })
})

test('num_ctx auto: 입력 길이로 계산하고, 모자라면 서버가 알려 준 토큰 수로 한 번 다시 보낸다', async () => {
  const f = await fake((b, res) => (b.options.num_ctx < 20000 ? fail(res, 400, exceed(15000, b.options.num_ctx)) : stream(res, ['됨'])))
  const [text, usage] = await ollama.chat(f.endpoint, 'm', [{ role: 'user', content: '가'.repeat(4000) }],
                                           { request: { options: { num_ctx: 'auto' } }, maxTokens: 8192 })
  assert.equal(text, '됨')
  assert.deepEqual(f.requests.map((r) => r.options.num_ctx), [12288, 24576]) // 4000×0.75+8192+512 → 12288, 15000+8192 → 24576
  assert.equal(usage['num_ctx'], 24576)
})

test('입력이 컨텍스트를 넘으면 자르지 않고 too_large로 멈춘다 (고정 num_ctx, 모델 최대치에 걸린 auto)', async () => {
  const fixed = await fake((b, res) => fail(res, 400, exceed(9000, b.options.num_ctx)))
  await assert.rejects(ollama.chat(fixed.endpoint, 'm', MESSAGES, { request: { options: { num_ctx: 4096 } }, maxTokens: 100 }),
                       (e: unknown) => e instanceof EngineError && e.code === 'too_large' && /9,000/.test(e.message))
  assert.equal(fixed.requests.length, 1)
  // 모델이 8192까지만 받는다: 더 큰 num_ctx를 줘도 n_ctx가 8192로 온다
  const capped = await fake((_b, res) => fail(res, 400, exceed(30000, 8192)))
  await assert.rejects(ollama.chat(capped.endpoint, 'm', MESSAGES, { request: { options: { num_ctx: 'auto' } }, maxTokens: 100 }),
                       (e: unknown) => e instanceof EngineError && e.code === 'too_large')
  assert.equal(capped.requests.length, 2)
})

test('think를 받지 않는 모델은 think 없이 다시 보내고, 다음부터는 처음부터 뺀다', async () => {
  const f = await fake((b, res) => ('think' in b ? fail(res, 400, '"nothink-model" does not support thinking') : stream(res, ['됨'])))
  const o = { request: { think: false, options: { num_ctx: 4096 } }, maxTokens: 10 }
  assert.equal((await ollama.chat(f.endpoint, 'nothink-model', MESSAGES, o))[0], '됨')
  await ollama.chat(f.endpoint, 'nothink-model', MESSAGES, o)
  assert.deepEqual(f.requests.map((r) => 'think' in r), [true, false, false])
})

test('오류: 없는 모델, 스트림 중 오류, 꺼진 Ollama, 조각이 안 올 때, 취소', async () => {
  const o = { request: {}, maxTokens: 10 }
  const missing = await fake((_b, res) => fail(res, 404, "model 'm' not found"))
  await assert.rejects(ollama.chat(missing.endpoint, 'm', MESSAGES, o), (e: unknown) => e instanceof EngineError && e.code === 'input')
  const broken = await fake((_b, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.end(JSON.stringify({ error: 'llama runner process has terminated' }) + '\n')
  })
  await assert.rejects(ollama.chat(broken.endpoint, 'm', MESSAGES, o), (e: unknown) => e instanceof EngineError && e.code === 'llm' && /terminated/.test(e.message))
  await assert.rejects(ollama.chat('http://127.0.0.1:9/api/chat', 'm', MESSAGES, o), (e: unknown) => e instanceof EngineError && e.code === 'network')

  const silent = await fake(() => new Promise(() => {})) // 답하지 않는다
  await assert.rejects(ollama.chat(silent.endpoint, 'm', MESSAGES, { ...o, firstMs: 50 }), (e: unknown) => e instanceof EngineError && e.code === 'timeout')
  const stalled = await fake((_b, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.write(JSON.stringify({ message: { content: '가' }, done: false }) + '\n') // 한 조각 뒤 멈춘다
  })
  await assert.rejects(ollama.chat(stalled.endpoint, 'm', MESSAGES, { ...o, idleMs: 50 }), (e: unknown) => e instanceof EngineError && e.code === 'timeout')
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(ollama.chat(silent.endpoint, 'm', MESSAGES, { ...o, signal: controller.signal }), (e: unknown) => e instanceof EngineError && e.code === 'cancelled')
})

test('로컬 다듬기: 한 번에 한 조각씩 보내고, 마지막 조각에만 모델 내리기를 넣고, 출력이 끊긴 조각은 원문을 쓴다', async () => {
  let active = 0
  let peak = 0
  let n = 0
  const f = await fake(async (b, res) => {
    peak = Math.max(peak, ++active)
    await new Promise((r) => setTimeout(r, 10))
    active--
    const text = (b.messages[1].content as string).replaceAll('컴파일라', '컴파일러')
    stream(res, [text], n++ === 0 ? { done_reason: 'length' } : {})
  })
  const paras = Array.from({ length: 3 }, (_, i) => ({ startMs: i * 60_000, endMs: (i + 1) * 60_000, text: '컴파일라는 소스 코드를 읽는다. '.repeat(80).trim() }))
  const r = await polishParagraphs(paras, '', { endpoint: f.endpoint, apiKey: null, model: 'm', ollama: ollama.DEFAULT_REQUEST.polish, unloadAfter: true })
  assert.equal(r.chunks, 3)
  assert.equal(peak, 1)
  assert.equal(r.fallbackChunks, 1)
  assert.match(r.paragraphs[0].text, /컴파일라/) // 끊긴 조각은 원문
  assert.doesNotMatch(r.paragraphs[1].text, /컴파일라/)
  assert.deepEqual(f.requests.map((q) => q.keep_alive), [undefined, undefined, 0])
  assert.equal(f.requests[0].options.num_ctx, 16384)
})

test('단계별 서비스: 요약 서비스와 로컬 LLM을 단계마다 따로 고른다', () => {
  const local = { ...DEFAULT_SETTINGS.ollama, polish: true, polishModel: 'gemma', summaryModel: 'qwen', summaryRequest: '{"options":{"num_ctx":32768}}' }
  // 기본 시나리오: 다듬기는 로컬, 요약은 ChatKHU
  const mixed = resolveSteps({ ...DEFAULT_SETTINGS, provider: 'chatkhu', polishModel: 'gpt-6-luna', ollama: local }, true)
  assert.equal(mixed.summary?.service, 'chatkhu')
  assert.equal(mixed.summary?.ollama, undefined)
  assert.deepEqual([mixed.polish?.service, mixed.polish?.model, mixed.polish?.ollama], ['ollama', 'gemma', ollama.DEFAULT_REQUEST.polish])
  // 키 없이 둘 다 로컬
  const all = resolveSteps({ ...DEFAULT_SETTINGS, ollama: { ...local, summary: true } }, false)
  assert.deepEqual([all.summary?.model, all.summary?.ollama], ['qwen', { options: { num_ctx: 32768 } }])
  assert.equal(all.polish?.model, 'gemma')
  // 로컬을 끄면 예전과 같다: 연결돼 있으면 요약 서비스, 아니면 요약 없음
  const off = { ...local, polish: false }
  assert.deepEqual(resolveSteps({ ...DEFAULT_SETTINGS, provider: 'chatkhu', polishModel: 'gpt-6-luna', ollama: off }, true).polish?.model, 'gpt-6-luna')
  assert.deepEqual(resolveSteps({ ...DEFAULT_SETTINGS, provider: 'chatkhu', ollama: off }, false), { summary: null, polish: null })
})
