import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { EngineError } from '../src/core/errors.ts'
import { chat } from '../src/core/llm.ts'
import { buildMessages, parseResponse, summarize } from '../src/core/summarize.ts'

const GOOD = { title: '렉시컬 분석', summary: '요약', keywords: ['Token', ' '], corrections: [{ wrong: 'a', right: 'b' }] }

function chatPayload(content: string): object {
  return { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
}

function mockFetch(status: number, body: object | string): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = []
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  })
  return { calls }
}

afterEach(() => mock.restoreAll())

test('parseResponse는 코드블록 표시를 벗기고 필드를 다듬는다', () => {
  const parsed = parseResponse('```json\n' + JSON.stringify(GOOD) + '\n```', '파일 이름')
  assert.equal(parsed.title, '렉시컬 분석')
  assert.deepEqual(parsed.keywords, ['Token'])
  assert.deepEqual(parsed.corrections, [{ wrong: 'a', right: 'b' }])
  assert.equal(parsed.parseFailed, false)
})

test('parseResponse는 JSON이 아니면 원문을 요약에 넣는다', () => {
  for (const raw of ['JSON이 아닌 응답', '["배열"]']) {
    const parsed = parseResponse(raw, '9.14 Lexical Analysis')
    assert.equal(parsed.title, '9.14 Lexical Analysis')
    assert.equal(parsed.summary, raw)
    assert.deepEqual(parsed.corrections, [])
    assert.equal(parsed.parseFailed, true)
  }
})

test('buildMessages는 빠진 입력을 표시한다', () => {
  const user = buildMessages('전사', '', null)[1].content
  assert.ok(user.includes('[과목]\n(미지정)') && user.includes('[필기노트]\n(없음)') && user.endsWith('[전사]\n전사'))
})

test('summarize는 json_schema를 보내고 usage를 돌려준다', async () => {
  const { calls } = mockFetch(200, chatPayload(JSON.stringify(GOOD)))
  const result = await summarize('전사', '필기', '컴파일러', {
    endpoint: 'https://x/chat/completions/', apiKey: 'secret', model: 'm', fallbackTitle: 't'
  })
  const body = JSON.parse(calls[0].init.body as string)
  assert.equal(body.response_format.json_schema.strict, true)
  assert.equal((calls[0].init.headers as Record<string, string>)['Authorization'], 'Bearer secret')
  assert.equal(result.title, '렉시컬 분석')
  assert.equal(result.usage?.completion_tokens, 5)
})

for (const [status, code] of [[401, 'auth'], [402, 'credits'], [413, 'too_large'], [429, 'rate_limit'], [503, 'network'], [400, 'llm']] as const) {
  test(`HTTP ${status}는 ${code} 오류이고 키를 메시지에 넣지 않는다`, async () => {
    mockFetch(status, 'bad')
    await assert.rejects(chat('https://x/', 'secret-key', 'm', []), (e: EngineError) => {
      assert.equal(e.code, code)
      assert.ok(!e.message.includes('secret-key'))
      return true
    })
  })
}

test('빈 응답은 llm 오류', async () => {
  mockFetch(200, chatPayload(''))
  await assert.rejects(chat('https://x/', null, 'm', []), (e: EngineError) => e.code === 'llm')
})

test('연결 실패는 network 오류', async () => {
  await assert.rejects(chat('http://127.0.0.1:9/', null, 'm', []), (e: EngineError) => e.code === 'network')
})
