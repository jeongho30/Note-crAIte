import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clean, collapseTokenLoops, transcriptText } from '../src/core/clean.ts'
import { apply, MAX_ITEMS, select } from '../src/core/corrections.ts'
import type { Segment } from '../src/core/stt/base.ts'

function seg(startS: number, text: string, durS = 1): Segment {
  return { startMs: startS * 1000, endMs: (startS + durS) * 1000, text }
}

test('반복 루프를 줄인다 (실제 small 모델 출력)', () => {
  assert.equal(collapseTokenLoops('A C C C C C C C C 그 다음에'), 'A C 그 다음에')
  assert.equal(collapseTokenLoops('R#, R#, R#, R#, R#, 이렇게'), 'R#, 이렇게')
  assert.equal(collapseTokenLoops('어떻게 구해요? ' + 'C제공을 많이 구해요 '.repeat(5)), '어떻게 구해요? C제공을 많이 구해요')
})

test('짧은 자연스러운 반복은 둔다', () => {
  assert.equal(collapseTokenLoops('네 네 네 알겠습니다'), '네 네 네 알겠습니다')
})

test('clean은 루프·환각·빈 구간을 지운다', () => {
  const segments = [
    seg(0, '그렇죠?'), seg(1, '그렇죠?'), // 2번은 실제 발화일 수 있어 둔다
    seg(2, '반복'), seg(3, '반복.'), seg(4, '반복'), seg(5, '반복'), // 3번 이상은 하나만
    seg(6, '시청해주셔서 감사합니다.'),
    seg(7, '  '),
    seg(8, '끝')
  ]
  const result = clean(segments)
  // 반복을 줄인 뒤 3초~8초가 비어 있어 "끝"은 새 문단이 된다
  assert.equal(transcriptText(result), '그렇죠? 그렇죠? 반복\n\n끝')
  assert.deepEqual(result.stats, { segmentsIn: 9, loopsCollapsed: 0, hallucinationsRemoved: 1, repeatsRemoved: 3 })
})

test('쉼과 길이로 문단을 나눈다', () => {
  const segments = [seg(0, '첫 문장'), seg(1.5, '이어짐'), seg(10, '쉬고 나서'), seg(11, '가'.repeat(400)), seg(12, '새 문단')]
  const paragraphs = clean(segments).paragraphs
  assert.deepEqual(paragraphs.map((p) => p.text.slice(0, 5)), ['첫 문장 ', '쉬고 나서', '새 문단'])
  assert.deepEqual(paragraphs.map((p) => p.startMs), [0, 10000, 12000])
})

const TEXT = '오늘은 렉시컬 애널리시스와 렉시컬 토큰을 다룹니다. 파서는 다음 시간에.'

test('select는 전사에 있고 2자 이상이며 정정어와 다른 항목만 고른다', () => {
  const picked = select([
    { wrong: '렉시컬 애널리시스', right: 'Lexical Analysis' },
    { wrong: '없는 표현', right: 'x' }, // 전사에 없음
    { wrong: '파', right: '파서' }, // 한 글자
    { wrong: '파서는', right: '파서는' }, // 정정어와 같음
    { wrong: '렉시컬 애널리시스', right: '중복' }, // 중복
    '문자열', // 형식 오류
    { wrong: '토큰을', right: '' } // 정정어 없음
  ], TEXT)
  assert.deepEqual(picked, [{ wrong: '렉시컬 애널리시스', right: 'Lexical Analysis' }])
})

test('select는 S2에서 본 해로운 항목을 버린다', () => {
  const text = '80번 줄의 associativity를 보면 Pulse Tree가 나옵니다'
  const picked = select([
    { wrong: '80', right: 'Parsing' }, // 숫자만: 다른 숫자까지 바뀐다
    { wrong: 'associativity', right: 'Associativity' }, // 대소문자만 다름
    { wrong: 'Pulse Tree', right: 'Parse Tree' }
  ], text)
  assert.deepEqual(picked, [{ wrong: 'Pulse Tree', right: 'Parse Tree' }])
})

test('apply는 영문 단어 경계를 지키고 한글 조사는 허용한다', () => {
  const [fixed, applied] = apply(['IDEA와 IDE를 비교'], [{ wrong: 'IDE', right: 'id' }])
  assert.deepEqual(fixed, ['IDEA와 id를 비교'])
  assert.deepEqual(applied, [{ wrong: 'IDE', right: 'id', count: 1 }])
})

test('apply는 한글 교정을 다른 단어 안에서 바꾸지 않고, 뒤에 붙은 조사는 허용한다', () => {
  const [fixed, applied] = apply(['터미널을 넌터미널로 바꾸고 펌츄에이션과 에이 등급'], [
    { wrong: '터미널', right: 'terminal' },
    { wrong: '에이', right: 'A' }
  ])
  assert.deepEqual(fixed, ['terminal을 넌터미널로 바꾸고 펌츄에이션과 A 등급'])
  assert.deepEqual(new Set(applied.map((c) => `${c.wrong}:${c.count}`)), new Set(['터미널:1', '에이:1']))
})

test('select는 개수를 제한한다', () => {
  const text = Array.from({ length: 100 }, (_, i) => `단어${i}`).join(' ')
  assert.equal(select(Array.from({ length: 100 }, (_, i) => ({ wrong: `단어${i}`, right: `word${i}` })), text).length, MAX_ITEMS)
})

test('apply는 긴 표현을 먼저 바꾸고 횟수를 센다', () => {
  const [fixed, applied] = apply([TEXT], [
    { wrong: '렉시컬', right: 'lexical' },
    { wrong: '렉시컬 애널리시스', right: 'Lexical Analysis' }
  ])
  assert.deepEqual(fixed, ['오늘은 Lexical Analysis와 lexical 토큰을 다룹니다. 파서는 다음 시간에.'])
  assert.deepEqual(new Set(applied.map((c) => `${c.wrong}:${c.count}`)), new Set(['렉시컬 애널리시스:1', '렉시컬:1']))
})

test('apply는 치환 결과를 다시 치환하지 않는다', () => {
  const [fixed] = apply(['파서'], [{ wrong: '파서', right: 'parser' }, { wrong: 'parser', right: '잘못' }])
  assert.deepEqual(fixed, ['parser'])
})

test('apply는 항목이 없으면 그대로 돌려준다', () => {
  assert.deepEqual(apply(['그대로'], []), [['그대로'], []])
})
