// OpenAI·Claude·Gemini 호출 (10/2). 실제 키가 없어 응답은 각 서비스의 문서에 적힌 형식으로 꾸민 것이다.
import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { EngineError } from '../src/core/errors.ts'
import { chat } from '../src/core/llm.ts'
import { polishParagraphs } from '../src/core/polish.ts'
import { listModels, PRESETS, resolveSteps, verifyKey } from '../src/core/providers.ts'
import { DEFAULT_SETTINGS } from '../src/core/settings.ts'
import { SCHEMA, summarize } from '../src/core/summarize.ts'

afterEach(() => mock.restoreAll())

type Call = { url: string; headers: Record<string, string>; body: Record<string, any> }

/** fetch를 가로채 요청을 모으고 reply가 준 응답을 돌려준다 */
function capture(reply: (c: Call, n: number) => Response): Call[] {
  const calls: Call[] = []
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
    const c = { url, headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : {} }
    calls.push(c)
    return reply(c, calls.length - 1)
  })
  return calls
}

const sse = (events: object[]): Response =>
  new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200, headers: { 'Content-Type': 'text/event-stream' }
  })

const claudeStream = (text: string[], stop = 'end_turn'): Response =>
  sse([
    { type: 'message_start', message: { usage: { input_tokens: 1200 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '생각' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    ...text.map((t) => ({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } })),
    { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 300 } },
    { type: 'message_stop' }
  ])

const MESSAGES = [{ role: 'system' as const, content: '규칙' }, { role: 'user' as const, content: '안녕' }]

test('Claude: system을 올리고 x-api-key로 보내며, 글 조각만 이어 붙이고 토큰 수를 돌려준다', async () => {
  const calls = capture(() => claudeStream(['안녕', '하세요']))
  const [text, usage] = await chat(PRESETS['claude'].endpoint, 'sk-test', 'claude-haiku-4-5', MESSAGES, {
    service: 'claude', maxTokens: 8192, responseFormat: { type: 'json_schema', json_schema: { name: 'x', strict: true, schema: SCHEMA } }
  })
  assert.equal(text, '안녕하세요')
  assert.deepEqual(usage, { prompt_tokens: 1200, completion_tokens: 300 })
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages')
  assert.equal(calls[0].headers['x-api-key'], 'sk-test')
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01')
  assert.equal(calls[0].headers['Authorization'], undefined)
  assert.deepEqual(calls[0].body, {
    model: 'claude-haiku-4-5', max_tokens: 32000, stream: true, system: '규칙', messages: [{ role: 'user', content: '안녕' }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } }
  })
})

test('Claude: 출력이 끊기면 요약은 오류, 거절·스트림 중 과부하·오류 응답을 구분한다', async () => {
  const o = { endpoint: PRESETS['claude'].endpoint, apiKey: 'k', model: 'm', fallbackTitle: 't', service: 'claude' }
  capture(() => claudeStream(['{"title":'], 'max_tokens'))
  await assert.rejects(summarize('전사', '', null, o), (e: unknown) => e instanceof EngineError && e.code === 'llm' && /끊겼어요/.test(e.message))
  capture(() => claudeStream([], 'refusal'))
  await assert.rejects(summarize('전사', '', null, o), (e: unknown) => e instanceof EngineError && /거절/.test(e.message))
  capture(() => sse([{ type: 'message_start', message: {} }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]))
  await assert.rejects(summarize('전사', '', null, o), (e: unknown) => e instanceof EngineError && e.code === 'network')

  const error = (status: number, type: string, message: string) => () => new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status })
  capture(error(401, 'authentication_error', 'invalid x-api-key'))
  await assert.rejects(summarize('전사', '', null, o), (e: unknown) => e instanceof EngineError && e.code === 'auth')
  capture(error(400, 'invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum'))
  await assert.rejects(summarize('전사', '', null, o), (e: unknown) => e instanceof EngineError && e.code === 'too_large')
  capture(error(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'))
  await assert.rejects(summarize('전사', '', null, o), (e: unknown) => e instanceof EngineError && e.code === 'credits')
  capture(error(529, 'overloaded_error', 'Overloaded'))
  await assert.rejects(summarize('전사', '', null, o), (e: unknown) => e instanceof EngineError && e.code === 'network')
})

const openaiReply = (content: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 })

test('OpenAI는 max_completion_tokens로, Gemini·ChatKHU는 max_tokens로 출력 상한을 보낸다', async () => {
  const calls = capture(() => openaiReply('답'))
  await chat(PRESETS['openai'].endpoint, 'k', 'm', MESSAGES, { service: 'openai', maxTokens: 100 })
  await chat(PRESETS['gemini'].endpoint, 'k', 'm', MESSAGES, { service: 'gemini', maxTokens: 100 })
  await chat(PRESETS['chatkhu'].endpoint, 'k', 'm', MESSAGES, { maxTokens: 100 })
  assert.deepEqual(calls.map((c) => [c.body.max_completion_tokens, c.body.max_tokens]), [[100, undefined], [undefined, 100], [undefined, 100]])
  assert.equal(calls[0].headers['Authorization'], 'Bearer k')
  assert.equal(calls[1].url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
})

test('429: 결제 한도 소진은 credits(기다려도 안 풀림), 요청 몰림은 rate_limit. 400 컨텍스트 초과는 too_large', async () => {
  const json = (status: number, error: object) => () => new Response(JSON.stringify({ error }), { status })
  capture(json(429, { code: 'insufficient_quota', message: 'You exceeded your current quota' }))
  await assert.rejects(chat('https://x/', 'k', 'm', MESSAGES), (e: unknown) => e instanceof EngineError && e.code === 'credits')
  capture(json(429, { code: 'credit_balance_exhausted', message: 'Credit balance exhausted' }))
  await assert.rejects(chat('https://x/', 'k', 'm', MESSAGES), (e: unknown) => e instanceof EngineError && e.code === 'credits')
  capture(json(429, { type: 'rate_limit_error', code: 'slow_down', message: 'Slow down' }))
  await assert.rejects(chat('https://x/', 'k', 'm', MESSAGES), (e: unknown) => e instanceof EngineError && e.code === 'rate_limit')
  capture(json(400, { code: 'context_length_exceeded', message: "This model's maximum context length is 128000 tokens" }))
  await assert.rejects(chat('https://x/', 'k', 'm', MESSAGES), (e: unknown) => e instanceof EngineError && e.code === 'too_large')
})

test('모델 목록: 서비스별 인증 헤더로 받고 글 모델만 남긴다. 키 확인은 이 호출로 한다', async () => {
  const lists: Record<string, object> = {
    'https://api.openai.com/v1/models': { data: ['gpt-6-luna', 'gpt-6-luna-audio-preview', 'text-embedding-4', 'o5-mini', 'gpt-image-2', 'whisper-1'].map((id) => ({ id })) },
    'https://generativelanguage.googleapis.com/v1beta/openai/models': { data: ['models/gemini-3.8-flash', 'models/gemini-embedding-2-preview', 'models/veo-3.1-generate-preview'].map((id) => ({ id })) },
    'https://api.anthropic.com/v1/models?limit=1000': { data: [{ id: 'claude-sonnet-5-5', type: 'model' }, { id: 'claude-haiku-4-5', type: 'model' }] }
  }
  const calls = capture((c) => new Response(JSON.stringify(lists[c.url]), { status: 200 }))
  assert.deepEqual((await listModels('openai', 'k')).map((m) => m.id), ['gpt-6-luna', 'o5-mini'])
  assert.deepEqual((await listModels('gemini', 'k')).map((m) => m.id), ['gemini-3.8-flash'])
  assert.deepEqual((await listModels('claude', 'k')).map((m) => m.id), ['claude-sonnet-5-5', 'claude-haiku-4-5'])
  assert.deepEqual(calls.map((c) => c.headers['x-api-key'] ?? c.headers['Authorization']), ['Bearer k', 'Bearer k', 'k'])
  assert.deepEqual(await verifyKey('claude', 'k'), { credits: null })

  capture(() => new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 }))
  await assert.rejects(verifyKey('openai', 'bad'), (e: unknown) => e instanceof EngineError && e.code === 'auth')
})

test('다듬기: 요청 몰림(429)에 걸린 조각만 기다렸다 다시 보내고, 계속 걸리면 rate_limit로 멈춘다', async () => {
  const paras = [{ startMs: 0, endMs: 1000, text: '컴파일라는 소스 코드를 읽는다.' }]
  const o = { endpoint: 'https://x/', apiKey: 'k', model: 'm', service: 'openai', rateLimitWaitsMs: [1, 1] }
  const calls = capture((_c, n) => (n < 2 ? new Response('{"error":{"code":"rate_limit_exceeded"}}', { status: 429 }) : openaiReply('컴파일러는 소스 코드를 읽는다.')))
  const r = await polishParagraphs(paras, '', o)
  assert.equal(calls.length, 3)
  assert.equal(r.paragraphs[0].text, '컴파일러는 소스 코드를 읽는다.')
  capture(() => new Response('{"error":{"code":"rate_limit_exceeded"}}', { status: 429 }))
  await assert.rejects(polishParagraphs(paras, '', o), (e: unknown) => e instanceof EngineError && e.code === 'rate_limit')
})

test('연결한 서비스가 요약·다듬기 대상이 된다: 기본 모델, 고른 모델', () => {
  const s = resolveSteps({ ...DEFAULT_SETTINGS, provider: 'claude', polishModel: 'claude-sonnet-5-5' }, true)
  assert.deepEqual(s.summary, { service: 'claude', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-haiku-4-5', creditsUrl: undefined })
  assert.equal(s.polish?.model, 'claude-sonnet-5-5')
  assert.equal(resolveSteps({ ...DEFAULT_SETTINGS, provider: 'gemini', summaryModel: 'gemini-x' }, true).summary?.model, 'gemini-x')
})
