import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { EngineError } from '../src/core/errors.ts'
import { chat } from '../src/core/llm.ts'
import { buildMessages, dropEchoedGloss, parseResponse, restoreLatex, summarize, SUMMARY_MAX_TOKENS } from '../src/core/summarize.ts'

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

test('restoreLatex는 JSON.parse가 제어 문자로 푼 LaTeX 명령을 되살린다', () => {
  // 모델이 JSON 문자열 안에 \theta를 역슬래시 하나로 쓰면 JSON.parse가 탭 + heta로 읽는다
  const broken = JSON.parse(String.raw`{"s": "각 $\theta$, $\frac{1}{2}$, SYN $\rightarrow$ ACK, $\beta$"}`).s as string
  assert.ok(broken.includes('\t') && broken.includes('\f') && broken.includes('\r') && broken.includes('\b'))
  assert.equal(restoreLatex(broken), String.raw`각 $\theta$, $\frac{1}{2}$, SYN $\rightarrow$ ACK, $\beta$`)
})

test('parseResponse는 요약 앞뒤에 붙은 summary 태그를 지운다', () => {
  const parse = (summary: string): string => parseResponse(JSON.stringify({ title: 't', summary, keywords: [], corrections: [] }), 't').summary
  assert.equal(parse('개요다.\n\n- **A**: 설명됨</summary>\n'), '개요다.\n\n- **A**: 설명됨')
  assert.equal(parse('<summary>\n개요다.</summary>'), '개요다.')
  assert.equal(parse('HTML의 <summary> 태그를 다룬다.'), 'HTML의 <summary> 태그를 다룬다.', '본문 안의 것은 그대로')
})

test('dropEchoedGloss는 앞 말을 그대로 되풀이한 괄호만 지운다', () => {
  const fixed: [string, string][] = [
    ['- **Closure**(Closure): 점 바로 뒤에', '- **Closure**: 점 바로 뒤에'],
    ['- **LR(k)**(LR(k)): 입력을', '- **LR(k)**: 입력을'],
    ['**GoTo**(GoTo)와 **Reduce**(Reduce)', '**GoTo**와 **Reduce**'],
    ['DFA(dfa)를 만든다', 'DFA를 만든다'],
    ['Go To(GoTo)로 간다', 'Go To로 간다'],
    ['Closure (Closure)는 반복한다', 'Closure는 반복한다']
  ]
  for (const [from, to] of fixed) assert.equal(dropEchoedGloss(from), to)
  const kept = [
    '**지연된 결정**(Delayed Decision): LL 파싱처럼',
    '**LR(0) 아이템**(LR(0) Item): 생산 규칙에',
    '**Shift-Reduce 파싱**(Shift-Reduce Parsing): Shift는',
    '**클로저**(Closure)와 **Closure**(클로저)',
    'Preclosure(Closure)는 다른 말',
    'S(S)는 문법 기호',
    '수식 $f(x)(x)$와 코드 `run(run)`',
    '닫지 않은 괄호 Closure(Closure\n다음 줄)'
  ]
  for (const s of kept) assert.equal(dropEchoedGloss(s), s)
  // 요약에만 적용하고 제목·키워드는 그대로 둔다
  const parsed = parseResponse(JSON.stringify({ ...GOOD, title: 'Closure(Closure)', summary: '**Closure**(Closure): 설명', keywords: ['GoTo(GoTo)'] }), 'x')
  assert.equal(parsed.summary, '**Closure**: 설명')
  assert.equal(parsed.title, 'Closure(Closure)')
  assert.deepEqual(parsed.keywords, ['GoTo(GoTo)'])
})

test('restoreLatex는 수식 밖의 탭과 줄바꿈을 건드리지 않는다', () => {
  for (const s of ['- 항목\n\tsub item', '첫 줄\r\nsecond line', '탭\tx와 달러 $5', '**파싱**(Parsing)은']) assert.equal(restoreLatex(s), s)
})

test('parseResponse는 요약·키워드·교정의 깨진 수식을 되살리고, JSON에 없는 이스케이프도 읽는다', () => {
  // \alpha는 JSON에 없는 이스케이프라 그대로는 파싱이 실패한다
  const raw = String.raw`{"title": "삼각함수", "summary": "$\theta$와 $\alpha$", "keywords": ["$\beta$"], "corrections": [{"wrong": "에스 화살표", "right": "S $\to$ S"}]}`
  const parsed = parseResponse(raw, 't')
  assert.equal(parsed.parseFailed, false)
  assert.equal(parsed.summary, String.raw`$\theta$와 $\alpha$`)
  assert.deepEqual(parsed.keywords, [String.raw`$\beta$`])
  assert.deepEqual(parsed.corrections, [{ wrong: '에스 화살표', right: String.raw`S $\to$ S` }])
  // 이미 겹쳐 쓴 역슬래시는 그대로 둔다
  const escaped = String.raw`{"title": "t", "summary": "$\\theta$ $\alpha$", "keywords": [], "corrections": []}`
  assert.equal(parseResponse(escaped, 't').summary, String.raw`$\theta$ $\alpha$`)
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
  assert.equal(body.max_tokens, SUMMARY_MAX_TOKENS) // 주제별 틀 + 추론 토큰이 chat()의 기본 8192를 넘는 모델이 있다
  assert.equal((calls[0].init.headers as Record<string, string>)['Authorization'], 'Bearer secret')
  assert.equal(result.title, '렉시컬 분석')
  assert.equal(result.usage?.completion_tokens, 5)
})

/** 스트리밍 응답: 조각이 바이트 경계에서 잘려 와도 이어 붙인다 */
function mockStream(lines: string[], splitAt = 7): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = []
  const bytes = new TextEncoder().encode(lines.map((l) => `data: ${l}\n\n`).join(''))
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += splitAt) c.enqueue(bytes.slice(i, i + splitAt))
        c.close()
      }
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
  })
  return { calls }
}

test('chat은 스트리밍으로 요청하고, 조각을 이어 붙여 본문과 usage를 돌려준다', async () => {
  const text = JSON.stringify(GOOD)
  const { calls } = mockStream([
    JSON.stringify({ choices: [{ delta: { reasoning_content: '생각 중' } }] }),
    JSON.stringify({ choices: [{ delta: { content: text.slice(0, 20) } }] }),
    JSON.stringify({ choices: [{ delta: { content: text.slice(20) } }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 40 } }),
    '[DONE]'
  ])
  const [content, usage] = await chat('https://x/', null, 'm', [])
  const body = JSON.parse(calls[0].init.body as string)
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(content, text)
  assert.deepEqual(usage, { prompt_tokens: 100, completion_tokens: 40 })
})

test('스트리밍 중 오류 조각은 llm 오류', async () => {
  mockStream([JSON.stringify({ error: { message: '모델 오류' } })])
  await assert.rejects(chat('https://x/', null, 'm', []), (e: EngineError) => e.code === 'llm' && e.message.includes('모델 오류'))
})

for (const [status, code] of [[401, 'auth'], [402, 'credits'], [413, 'too_large'], [429, 'rate_limit'], [524, 'timeout'], [504, 'timeout'],
                               [503, 'network'], [400, 'llm']] as const) {
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
