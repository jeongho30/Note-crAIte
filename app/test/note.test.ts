import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { findNotes, readNotes } from '../src/core/inputs.ts'
import { escapeTags, renderNote, safeName, saveNote, timestamp } from '../src/core/note.ts'
import type { NoteInput } from '../src/core/note.ts'
import { writeFile } from 'node:fs/promises'
import { tempDir } from './helpers.ts'

const BASE: NoteInput = {
  title: '파싱과 "LL(1)"',
  subject: '자료 구조',
  date: '2026-10-05',
  source: '9.14 Lexical Analysis.m4a',
  stt: 'whisper.cpp large-v3-turbo-q8_0',
  llm: 'gemini-3.8-flash',
  summary: '**파싱**을 다뤘다.',
  keywords: ['LL(1)', 'FIRST'],
  transcript: ['교정된 첫 문단', '둘째 문단'],
  original: [{ startMs: 0, endMs: 1000, text: '원문 첫 문단' }, { startMs: 3725000, endMs: 3726000, text: '둘째' }],
  applied: [{ wrong: '팔싱', right: '파싱', count: 3 }]
}

test('timestamp는 1시간 미만이면 mm:ss, 넘으면 h:mm:ss', () => {
  assert.equal(timestamp(0), '00:00')
  assert.equal(timestamp(65_000), '01:05')
  assert.equal(timestamp(3_725_000), '1:02:05')
})

test('renderNote는 frontmatter를 이스케이프하고 접는 부분의 모든 줄을 callout으로 쓴다', () => {
  const md = renderNote(BASE)
  assert.match(md, /^---\ntitle: "파싱과 \\"LL\(1\)\\""\nsubject: "자료 구조"\ndate: 2026-10-05\n/)
  assert.match(md, /tags: \["lecture","자료_구조"\]/)
  assert.match(md, /## 요약\n\n\*\*파싱\*\*을 다뤘다\.\n\n## 주요 키워드\n\n- LL\(1\)\n- FIRST/)
  assert.match(md, /> \[!quote\]- 전사문\n> 교정된 첫 문단\n>\n> 둘째 문단\n/)
  const start = md.indexOf('> [!quote]- 원문 정리본')
  const quote = md.slice(start, md.indexOf('\n\n', start)) // 다음 callout과는 빈 줄로 나뉜다
  assert.ok(quote.split('\n').every((line) => line.startsWith('>')), '콜아웃 밖으로 새는 줄이 없어야 함')
  assert.match(quote, /> \*\*\[00:00\]\*\* 원문 첫 문단\n>\n> \*\*\[1:02:05\]\*\* 둘째/)
  assert.match(md, /> \[!quote\]- 교정 내역 \(1건\)\n> - 팔싱 → 파싱 \(3회\)/)
})

test('태그처럼 보이는 꺾쇠와 #낱말은 글자로 남긴다 (옵시디언이 HTML·태그로 읽지 않게)', () => {
  assert.equal(escapeTags('#include <iostream>이 뭐해? </div> <!-- -->'), '\\#include \\<iostream>이 뭐해? \\</div> \\<!-- -->')
  assert.equal(escapeTags('(#define) #2학기 #123 C#은 a#b # 제목 &#39; `#if`'), '(\\#define) \\#2학기 #123 C#은 a#b # 제목 &#39; `#if`', '낱말 앞의 #만')
  assert.equal(escapeTags('a < b, 3<5, `vector<int>`, $a<b$'), 'a < b, 3<5, `vector<int>`, $a<b$', '부등호·코드·수식은 그대로')
  assert.equal(escapeTags('add_i$sp$$. $ra에 <a>', true), 'add_i\\$sp\\$\\$. \\$ra에 \\<a>', '전사문에서는 $도 글자로')
  // 요약: 레지스터 이름 둘이 수식 하나로 묶이는 것만 글자로, 진짜 수식은 그대로
  assert.equal(escapeTags('$zero는 0, $v0–$v1은 반환값, $a0–$a3은 인자, LW $t0, 32($s3)로'), '$zero는 0, \\$v0–\\$v1은 반환값, \\$a0–\\$a3은 인자, LW \\$t0, 32(\\$s3)로')
  assert.equal(escapeTags('각 $\\theta$만큼 돌리면 $(x, y)$를 $e_1, e_2$로, `$v0–$v1`'), '각 $\\theta$만큼 돌리면 $(x, y)$를 $e_1, e_2$로, `$v0–$v1`')
  assert.equal(escapeTags('문장($S$), 표현식($E$), 목록($L$)이'), '문장($S$), 표현식($E$), 목록($L$)이', '수식의 닫는 $를 다음 구간의 여는 $로 쓰지 않는다')
  const once = escapeTags('$zero는 0, $v0–$v1은 반환값, **$gp·$sp·$ra**: $gp는')
  assert.equal(escapeTags(once), once, '두 번 적용해도 같다')
  const dollars = renderNote({ ...BASE, summary: '$a<b$이면 $ra에 저장', transcript: ['add_i$sp$$. 원래'] })
  assert.ok(dollars.includes('## 요약\n\n$a<b$이면 $ra에 저장'), '요약의 수식은 그대로')
  assert.ok(dollars.includes('> add_i\\$sp\\$\\$. 원래'))
  const md = renderNote({ ...BASE, summary: '**<fstream>**: 파일 입출력', keywords: ['<iostream>'], transcript: ['#include <iostream> 뭐해?'] })
  assert.ok(md.includes('## 요약\n\n**\\<fstream>**'))
  assert.ok(md.includes('\n- \\<iostream>\n'))
  assert.ok(md.includes('> \\#include \\<iostream> 뭐해?'))
})

test('요약이 없으면 요약·키워드 없이 전사만 담고, 교정이 없으면 교정 내역도 없다', () => {
  const md = renderNote({ ...BASE, llm: null, summary: null, keywords: [], applied: [] })
  assert.doesNotMatch(md, /## 요약|## 주요 키워드|교정 내역|^llm:/m)
  assert.match(md, /> \[!quote\]- 전사문/)
})

test('safeName은 Windows에서 못 쓰는 이름을 고친다', () => {
  assert.equal(safeName('a/b:c?  d*'), 'a b c d')
  assert.equal(safeName('끝에 점...'), '끝에 점')
  assert.equal(safeName('con'), '_con')
  assert.equal(safeName('???'), '_')
})

test('saveNote는 과목 폴더에 쓰고, 이름이 겹치면 번호를 붙이고, 이전 경로가 있으면 덮어쓴다', async () => {
  const out = await tempDir()
  const first = await saveNote(out, '자료구조', '2026-10-05', '이진 탐색 트리', 'A')
  const second = await saveNote(out, '자료구조', '2026-10-05', '이진 탐색 트리', 'B')
  assert.equal(first, join(out, '자료구조', '2026-10-05 이진 탐색 트리.md'))
  assert.equal(second, join(out, '자료구조', '2026-10-05 이진 탐색 트리 (2).md'))
  // 이전 경로가 있고 날짜·제목이 그대로면 그 파일에 덮어쓴다 (" (2)"가 붙은 파일도 같은 이름으로 본다)
  assert.equal(await saveNote(out, '자료구조', '2026-10-05', '이진 탐색 트리', 'C', second), second)
  assert.equal(await readFile(second, 'utf8'), 'C')
  // 제목이 바뀌면 같은 폴더에 새 이름으로 쓰고 옛 파일은 지운다 (과목 폴더를 옮겨 둔 노트는 옮긴 폴더에 남는다)
  const renamed = await saveNote(out, '다른 과목', '2026-10-05', '다른 제목', 'D', second)
  assert.equal(renamed, join(out, '자료구조', '2026-10-05 다른 제목.md'))
  assert.equal(await readFile(renamed, 'utf8'), 'D')
  assert.equal(existsSync(second), false)
  // 새 이름이 이미 있으면 번호를 붙인다
  assert.equal(await saveNote(out, '자료구조', '2026-10-05', '이진 탐색 트리', 'E', renamed), second)
  assert.equal(await readFile(first, 'utf8'), 'A')
  assert.equal(await saveNote(out, null, '2026-10-06', '특강', 'D'), join(out, '미분류', '2026-10-06 특강.md'))
})

test('findNotes는 점이 든 이름에서 실제 확장자만 떼고 .md, .txt 순으로 찾는다', async () => {
  const dir = await tempDir()
  const audio = join(dir, '9.14 Lexical Analysis.m4a')
  assert.equal(findNotes(audio), null)
  await writeFile(join(dir, '9.14 Lexical Analysis.txt'), '필기')
  assert.equal(findNotes(audio), join(dir, '9.14 Lexical Analysis.txt'))
  await writeFile(join(dir, '9.14 Lexical Analysis.md'), '필기')
  assert.equal(findNotes(audio), join(dir, '9.14 Lexical Analysis.md'))
})

test('readNotes는 UTF-8(BOM 포함)을 읽고, 아니면 CP949로 읽는다', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'u.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('한글', 'utf8')]))
  await writeFile(join(dir, 'c.txt'), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb])) // "한글" (CP949)
  assert.equal(await readNotes(join(dir, 'u.md')), '한글')
  assert.equal(await readNotes(join(dir, 'c.txt')), '한글')
})
