import assert from 'node:assert/strict'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { attachNotes, pairInputs } from '../src/core/inputs.ts'
import { recentNotes } from '../src/core/recent.ts'
import { tempDir } from './helpers.ts'

test('pairInputs: 함께 넣은 같은 이름 필기를 짝짓고, 없으면 녹음 옆에서 찾는다', async () => {
  const dir = await tempDir()
  const a = join(dir, '9.14 Lexical Analysis.m4a') // 이름의 점은 확장자가 아니다
  const aNotes = join(dir, '9.14 Lexical Analysis.md')
  const b = join(dir, '9.21 compiler.MP3')
  const bNotes = join(dir, '9.21 compiler.txt') // 넣지 않았지만 녹음 옆에 있다
  const c = join(dir, '9.28 강의.webm')
  for (const f of [a, aNotes, b, bNotes, c]) await writeFile(f, '')

  const { recordings, ignored } = pairInputs([a, aNotes, b, c, join(dir, '과제.pdf'), join(dir, '혼자 넣은 필기.md'), a])
  assert.deepEqual(recordings, [
    { audio: a, notes: aNotes },
    { audio: b, notes: bNotes },
    { audio: c, notes: null }
  ])
  assert.deepEqual(ignored, [join(dir, '과제.pdf'), join(dir, '혼자 넣은 필기.md')], '녹음이 아닌 파일과 짝 없는 필기, 중복은 한 번')
})

test('attachNotes: 목록에 있는 녹음의 필기는 붙이고, 함께 고른 새 녹음의 필기와 짝 없는 필기는 남긴다', () => {
  const a = join('강의', '9.14 Lexical.m4a')
  const b = join('강의', '9.21 compiler.mp3')
  const other = join('다른 폴더', '9.21 compiler.mp3') // 이름이 같은 녹음이 둘이면 이름만으로는 붙이지 않는다
  const aNotes = join('강의', '9.14 Lexical.md')
  const moved = join('필기 모음', '9.14 Lexical.txt') // 다른 폴더의 필기도 이름이 같고 녹음이 하나면 붙인다
  const newAudio = join('새', '10.05 graph.wav')
  const newNotes = join('새', '10.05 graph.md') // 함께 고른 새 녹음의 필기
  const solo = join('강의', '혼자.md')

  assert.deepEqual(attachNotes([a, b], [aNotes, newAudio, newNotes, solo]), {
    attached: [{ audio: a, notes: join(process.cwd(), aNotes) }],
    rest: [newAudio, newNotes, solo].map((p) => join(process.cwd(), p))
  })
  assert.deepEqual(attachNotes([a, b], [moved]).attached, [{ audio: a, notes: join(process.cwd(), moved) }])
  assert.deepEqual(attachNotes([b, other], [join('필기 모음', '9.21 compiler.md')]).attached, [])
})

test('recentNotes: 저장 폴더와 과목 폴더의 .md를 최근 수정 순으로, 이름의 날짜를 읽는다', async () => {
  const out = await tempDir()
  const at = (day: number): Date => new Date(2026, 8, day, 12)
  const files: [string, number][] = [
    [join(out, '컴파일러', '2026-09-21 Lexical Analysis.md'), 21],
    [join(out, '자료구조', '2026-09-22 이진 탐색 트리.md'), 22],
    [join(out, '자료구조', '과제 메모.md'), 25], // 이 앱이 만들지 않은 노트: 수정한 날짜
    [join(out, '루트 노트.md'), 23],
    [join(out, '.obsidian', 'workspace.md'), 30], // 숨김 폴더는 뺀다
    [join(out, '컴파일러', '녹음.m4a'), 29], // .md만
    [join(out, '컴파일러', '깊은', '2026-09-26 두 단계 아래.md'), 26] // 과목 폴더 한 단계 아래까지만
  ]
  for (const [f, day] of files) {
    await mkdir(join(f, '..'), { recursive: true })
    await writeFile(f, '')
    await utimes(f, at(day), at(day))
  }
  const notes = await recentNotes(out, 3)
  assert.deepEqual(
    notes.map((n) => [n.subject, n.title, n.date]),
    [
      ['자료구조', '과제 메모', '2026-09-25'],
      [null, '루트 노트', '2026-09-23'],
      ['자료구조', '이진 탐색 트리', '2026-09-22']
    ]
  )
  assert.deepEqual(await recentNotes(join(out, '없는 폴더')), [])
})
