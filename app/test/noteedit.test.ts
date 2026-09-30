import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { renderNote, saveNote } from '../src/core/note.ts'
import { editNote, parseNoteProps } from '../src/core/noteedit.ts'
import { tempDir } from './helpers.ts'

async function makeNote(out: string, subject: string | null, title = 'Lexical Analysis', date = '2026-09-21'): Promise<string> {
  const markdown = renderNote({
    title, subject, date, source: 'a.m4a', stt: 'whisper.cpp small', llm: 'gpt-6-luna', summary: '요약', keywords: ['토큰'],
    transcript: ['첫 문단'], original: [{ startMs: 0, endMs: 1000, text: '첫 문단' }], applied: []
  })
  return saveNote(out, subject, date, title, markdown)
}

test('editNote: 제목·과목·날짜를 머리말·제목 줄·파일 이름·폴더에 함께 반영하고 본문은 그대로 둔다', async () => {
  const out = await tempDir()
  const path = await makeNote(out, '컴파일러')
  const before = await readFile(path, 'utf8')
  // 옵시디언에서 더한 태그는 남겨야 한다
  await writeFile(path, before.replace('tags: ["lecture","컴파일러"]', 'tags: ["lecture","컴파일러","중요"]'))

  const r = await editNote(out, path, { title: '  렉시컬  분석 ', subject: '운영체제', date: '2026-09-22' })
  assert.equal(r.path, join(out, '운영체제', '2026-09-22 렉시컬 분석.md'))
  assert.ok(!existsSync(path), '옛 파일은 없어진다')
  const after = await readFile(r.path, 'utf8')
  assert.match(after, /^title: "렉시컬 분석"$/m)
  assert.match(after, /^subject: "운영체제"$/m)
  assert.match(after, /^date: 2026-09-22$/m)
  assert.match(after, /^tags: \["lecture","중요","운영체제"\]$/m)
  assert.match(after, /^# 렉시컬 분석$/m)
  assert.equal(after.slice(after.indexOf('## 요약')), before.slice(before.indexOf('## 요약')), '본문은 그대로')
  assert.deepEqual(parseNoteProps(after), { title: '렉시컬 분석', subject: '운영체제', date: '2026-09-22' })
})

test('editNote: 과목을 없애면 미분류 폴더로, 같은 이름이 있으면 (2)를 붙이고, 그대로면 제자리', async () => {
  const out = await tempDir()
  const a = await makeNote(out, '컴파일러')
  await makeNote(out, null) // 미분류/2026-09-21 Lexical Analysis.md
  const moved = await editNote(out, a, { title: 'Lexical Analysis', subject: null, date: '2026-09-21' })
  assert.equal(moved.path, join(out, '미분류', '2026-09-21 Lexical Analysis (2).md'))
  const after = await readFile(moved.path, 'utf8')
  assert.doesNotMatch(after, /^subject:/m)
  assert.match(after, /^tags: \["lecture"\]$/m)

  const same = await editNote(out, moved.path, { title: 'Lexical Analysis', subject: null, date: '2026-09-21' })
  assert.equal(same.path, moved.path, '바뀐 것이 없으면 이름도 폴더도 그대로')
})

test('editNote: 앱이 만들지 않은 노트와 잘못된 값은 고치지 않는다', async () => {
  const out = await tempDir()
  await mkdir(join(out, '메모'), { recursive: true })
  const foreign = join(out, '메모', '내 노트.md')
  await writeFile(foreign, '---\ntitle: 내 노트\n---\n본문\n')
  assert.equal(parseNoteProps('본문만 있는 노트'), null)
  await assert.rejects(editNote(out, foreign, { title: '바꿈', subject: null, date: '2026-09-21' }), /이 앱이 만든 노트만/)
  assert.equal(await readFile(foreign, 'utf8'), '---\ntitle: 내 노트\n---\n본문\n')

  const path = await makeNote(out, '컴파일러')
  await assert.rejects(editNote(out, path, { title: '   ', subject: '컴파일러', date: '2026-09-21' }), /제목/)
  await assert.rejects(editNote(out, path, { title: 'x', subject: '컴파일러', date: '2026-02-30' }), /날짜/)
  assert.ok(existsSync(path))
})
