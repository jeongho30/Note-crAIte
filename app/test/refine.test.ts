import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, mock, test } from 'node:test'
import { acceptable, chunkParagraphs, polishParagraphs } from '../src/core/polish.ts'
import { verifyCorrections, verifyInput } from '../src/core/verify.ts'

afterEach(() => mock.restoreAll())

const p = (text: string, i = 0) => ({ startMs: i * 1000, endMs: i * 1000 + 500, text })

/** 요청 본문을 보고 답을 고르는 가짜 서버 (한 번에 온 JSON 응답) */
function mockChat(answer: (body: { messages: { role: string; content: string }[] }) => string): string[] {
  const users: string[] = []
  mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    users.push(body.messages.at(-1).content)
    return new Response(JSON.stringify({ choices: [{ message: { content: answer(body) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }), { status: 200 })
  })
  return users
}

test('chunkParagraphs는 문단을 약 2000자 조각으로 묶는다', () => {
  const chunks = chunkParagraphs([p('가'.repeat(1500), 0), p('나'.repeat(600), 1), p('다'.repeat(100), 2)])
  assert.deepEqual(chunks.map((c) => c.length), [1, 2])
})

test('acceptable은 문단 수가 같고 길이가 크게 달라지지 않은 조각만 받는다', () => {
  const input = [p('안녕하세요 강의를 시작합니다'), p('오늘은 파싱')]
  assert.equal(acceptable(input, ['안녕하세요 강의를 시작합니다', '오늘은 파싱을']), true)
  assert.equal(acceptable(input, ['안녕하세요 강의를 시작합니다 오늘은 파싱']), false, '문단 수가 다름')
  assert.equal(acceptable(input, ['안녕', '오늘']), false, '내용이 빠짐')
})

test('polishParagraphs는 다듬은 문단을 시각과 함께 돌려주고, 검사에 걸린 조각은 원문을 쓴다', async () => {
  // 두 번째 문단이 2000자를 넘어 조각이 셋이 된다
  const paras = [p('팔싱을 합니다', 0), p('가'.repeat(2100), 1), p('런 터미널을 대체', 2)]
  mockChat((body) => {
    const user = body.messages.at(-1)!.content
    if (user.startsWith('팔싱')) return '파싱을 합니다'
    if (user.startsWith('가')) return '줄어든 답' // 너무 짧아져 원문을 쓴다
    return user
  })
  const r = await polishParagraphs(paras, '', { endpoint: 'https://x/', apiKey: 'k', model: 'gpt-6-luna' })
  assert.deepEqual(r.paragraphs.map((x) => x.text), ['파싱을 합니다', '가'.repeat(2100), '런 터미널을 대체'])
  assert.deepEqual(r.paragraphs.map((x) => x.startMs), [0, 1000, 2000])
  assert.equal(r.chunks, 3)
  assert.equal(r.fallbackChunks, 1)
  assert.equal(r.inputTokens, 300)
})

test('polishParagraphs는 조각 결과를 남겨 두고, 다시 부르면 끝난 조각은 다시 보내지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ln-polish-'))
  try {
    const paras = [p('가'.repeat(1900), 0), p('나'.repeat(1900), 1), p('다'.repeat(1900), 2)]
    const o = { endpoint: 'https://x/', apiKey: 'k', model: 'gpt-6-luna', resumeDir: dir, rateLimitWaitsMs: [] }
    // 처음에는 세 번째 조각에서 실패한다
    let users = mockChat((body) => {
      const user = body.messages.at(-1)!.content
      if (user.startsWith('다')) throw new Error('끊김')
      return user.startsWith('나') ? '줄어든 답' : user
    })
    await assert.rejects(polishParagraphs(paras, '', o))
    assert.equal(users.length, 3)
    mock.restoreAll()
    // 다시 부르면 실패한 조각만 보내고, 앞선 결과(원문으로 돌아간 조각 포함)와 토큰 수를 그대로 쓴다
    users = mockChat((body) => body.messages.at(-1)!.content)
    const r = await polishParagraphs(paras, '', o)
    assert.deepEqual(users.map((u) => u[0]), ['다'])
    assert.equal(r.fallbackChunks, 1)
    assert.equal(r.inputTokens, 300)
    mock.restoreAll()
    // 모델이 바뀌면 전부 다시 보낸다
    users = mockChat((body) => body.messages.at(-1)!.content)
    await polishParagraphs(paras, '', { ...o, model: 'gemma' })
    assert.equal(users.length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('verifyInput은 바꿀 곳의 앞뒤 문맥을 보이고, 다른 단어 안은 세지 않는다', () => {
  const input = verifyInput('이 터미널을 넌터미널로 바꾼다', [{ wrong: '터미널', right: 'terminal' }], '컴파일러')
  assert.match(input, /0\. 터미널 → terminal \(1곳\)/)
  assert.match(input, /이 【터미널】을 넌터미널로/)
})

test('verifyCorrections는 keep이 true인 교정만 남긴다', async () => {
  mockChat(() => JSON.stringify({ results: [{ id: 0, keep: true }, { id: 1, keep: false }] }))
  const items = [{ wrong: '팔싱', right: '파싱' }, { wrong: '토큰', right: 'token' }, { wrong: '런 터미널', right: '넌터미널' }]
  const r = await verifyCorrections('팔싱과 토큰과 런 터미널', items, null, { endpoint: 'https://x/', apiKey: 'k', model: 'gpt-6-luna' })
  assert.deepEqual(r.kept, [items[0]])
  assert.deepEqual(r.rejected, [items[1], items[2]], '판정이 빠진 항목은 버린다')
})
