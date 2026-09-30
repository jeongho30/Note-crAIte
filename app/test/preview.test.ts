import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderNote } from '../src/core/note.ts'
import { filterNotes } from '../src/renderer/src/notes/filter.ts'
import { md, parseNote } from '../src/renderer/src/preview/markdown.ts'

const NOTE = renderNote({
  title: 'Lexical Analysis',
  subject: '컴파일러',
  date: '2026-09-21',
  source: '9.21 compiler.m4a',
  stt: 'whisper.cpp large-v3-turbo-q8_0',
  llm: 'gemini-3.8-flash',
  summary: '렉시컬 분석은 **토큰**으로 나누는 단계입니다.',
  keywords: ['Token', 'NFA'],
  transcript: ['첫 문단', '둘째 문단'],
  original: [{ startMs: 0, endMs: 1000, text: '첫 문단' }],
  applied: [{ wrong: '런 터미널', right: 'non-terminal', count: 2 }]
})

test('앱이 만든 노트: 머리말·제목·요약·키워드 칩·접는 영역으로 나눈다', () => {
  const n = parseNote(NOTE)
  assert.equal(n.meta['subject'], '컴파일러')
  assert.equal(n.meta['llm'], 'gemini-3.8-flash')
  assert.deepEqual(n.meta['tags'], ['lecture', '컴파일러'])
  assert.equal(n.title, 'Lexical Analysis')
  assert.deepEqual(
    n.segments.map((s) => s.kind),
    ['markdown', 'keywords', 'callout', 'callout', 'callout']
  )
  assert.ok(n.segments[0].kind === 'markdown' && n.segments[0].text.includes('## 요약') && n.segments[0].text.includes('## 주요 키워드'))
  assert.deepEqual(n.segments[1], { kind: 'keywords', items: ['Token', 'NFA'] })
  const transcript = n.segments[2]
  assert.ok(transcript.kind === 'callout')
  assert.equal(transcript.title, '전사문')
  assert.equal(transcript.open, false)
  assert.equal(transcript.text, '첫 문단\n\n둘째 문단')
  assert.ok(n.segments[4].kind === 'callout' && n.segments[4].title === '교정 내역 (1건)')
})

test('다른 앱이 쓴 노트: 머리말·제목이 없어도 본문 그대로, 펼친 callout은 열어 둔다', () => {
  const n = parseNote('그냥 문단\r\n\r\n> [!note] 메모\r\n> 안쪽\r\n\r\n## 주요 키워드\r\n\r\n(없음)\r\n')
  assert.deepEqual(n.meta, {})
  assert.equal(n.title, null)
  assert.deepEqual(n.segments, [
    { kind: 'markdown', text: '그냥 문단\n' },
    { kind: 'callout', title: '메모', open: true, text: '안쪽' },
    { kind: 'markdown', text: '\n## 주요 키워드\n\n(없음)\n' }
  ])
})

test('닫는 ** 앞이 문장부호이고 뒤에 조사가 붙어도 굵게, HTML은 글자로', () => {
  assert.equal(md.render('이번 강의는 **파싱(Parsing)**을 다룹니다.'), '<p>이번 강의는 <strong>파싱(Parsing)</strong>을 다룹니다.</p>\n')
  assert.equal(md.render('<b>x</b>'), '<p>&lt;b&gt;x&lt;/b&gt;</p>\n')
})

test('수식: 한 줄·블록은 LaTeX로 그리고, 돈 표기의 $는 그대로, 오류는 던지지 않는다', () => {
  assert.match(md.render(String.raw`합 $\sum_{i=1}^n i$ 이다`), /class="katex"/)
  assert.match(md.render(String.raw`$$\int_0^1 x\,dx$$`), /katex-display/)
  assert.doesNotMatch(md.render('$5와 $10 입니다'), /katex/)
  assert.match(md.render(String.raw`$\frac{1}{$ 오류`), /katex-error/)
})

test('노트 목록: 제목·과목의 낱말로 찾고, 과목·미분류로 거르고, 강의 날짜 순은 같은 날이면 최근 수정 순', () => {
  const note = (title: string, subject: string | null, date: string, modifiedMs: number) => ({ path: `${title}.md`, title, subject, date, modifiedMs })
  const notes = [
    note('Lexical Analysis', '컴파일러', '2026-09-21', 3),
    note('Parsing', '컴파일러', '2026-09-28', 1),
    note('BST', '자료구조', '2026-09-28', 2),
    note('메모', null, '2026-09-01', 4)
  ]
  const titles = (r: { title: string }[]): string[] => r.map((n) => n.title)
  assert.deepEqual(titles(filterNotes(notes, '', { kind: 'all' }, 'modified')), ['메모', 'Lexical Analysis', 'BST', 'Parsing'])
  assert.deepEqual(titles(filterNotes(notes, '', { kind: 'all' }, 'date')), ['BST', 'Parsing', 'Lexical Analysis', '메모'])
  assert.deepEqual(titles(filterNotes(notes, 'lex 컴파', { kind: 'all' }, 'modified')), ['Lexical Analysis'])
  assert.deepEqual(titles(filterNotes(notes, '', { kind: 'subject', name: '컴파일러' }, 'date')), ['Parsing', 'Lexical Analysis'])
  assert.deepEqual(titles(filterNotes(notes, '', { kind: 'none' }, 'modified')), ['메모'])
})
