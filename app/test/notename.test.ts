// 노트 파일 이름 "<날짜> <제목>.md"는 세 곳이 같은 규칙을 공유한다: note.ts(만들기), recent.ts(목록에서 되읽기),
// noteedit.ts(제목·날짜 수정 때 다시 만들기). 각각의 테스트는 따로 있으니, 여기서는 셋을 이어서 돌려
// 한 곳만 바뀌면 깨지게 한다.
import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { test } from 'node:test'
import { renderNote, saveNote } from '../src/core/note.ts'
import { editNote } from '../src/core/noteedit.ts'
import { listNotes } from '../src/core/recent.ts'
import { tempDir } from './helpers.ts'

test('노트 파일 이름: 만들기 → 목록 → 수정 → 목록이 같은 규칙을 공유한다', async () => {
  const out = await tempDir()
  const markdown = renderNote({
    title: 'Lexical Analysis', subject: '컴파일러', date: '2026-09-21', source: 'a.m4a', stt: 'whisper.cpp small',
    llm: 'gpt-6-luna', summary: '요약', keywords: ['토큰'], transcript: ['첫 문단'],
    original: [{ startMs: 0, endMs: 1000, text: '첫 문단' }], applied: []
  })

  // 만들기: 날짜와 제목으로 이름을 짓는다
  const path = await saveNote(out, '컴파일러', '2026-09-21', 'Lexical Analysis', markdown)
  assert.equal(basename(path), '2026-09-21 Lexical Analysis.md')

  // 되읽기: 목록이 그 이름에서 날짜와 제목을 다시 뽑는다
  let notes = await listNotes(out)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].date, '2026-09-21')
  assert.equal(notes[0].title, 'Lexical Analysis')
  assert.equal(notes[0].subject, '컴파일러')

  // 다시 만들기: 제목·날짜를 고치면 같은 규칙으로 새 이름이 되고, 목록도 그것을 읽는다
  const edited = await editNote(out, path, { title: '렉시컬 분석', subject: '컴파일러', date: '2026-09-22' })
  assert.equal(basename(edited.path), '2026-09-22 렉시컬 분석.md')
  notes = await listNotes(out)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].path, edited.path)
  assert.equal(notes[0].date, '2026-09-22')
  assert.equal(notes[0].title, '렉시컬 분석')
})
