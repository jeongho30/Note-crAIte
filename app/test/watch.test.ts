import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  baselineKey, DONE_DIR, fingerprint, loadWatchState, MIN_AGE_MS, moveToDone, saveWatchState, scanWatchFolder, settled, subjectDirs
} from '../src/core/watch.ts'
import type { WatchFile } from '../src/core/watch.ts'
import { tempDir } from './helpers.ts'

test('감시 폴더: 바로 아래는 미분류, 하위 폴더는 과목. 처리됨·숨김 폴더와 녹음이 아닌 파일·임시 파일은 보지 않는다', async () => {
  const root = await tempDir()
  await mkdir(join(root, '컴파일러', DONE_DIR), { recursive: true })
  await mkdir(join(root, '.sync'))
  await writeFile(join(root, '메모 녹음.m4a'), 'a')
  await writeFile(join(root, '컴파일러', '9.21 Lexical.m4a'), 'b')
  await writeFile(join(root, '컴파일러', '9.21 Lexical.md'), '필기')
  await writeFile(join(root, '컴파일러', '~$임시.m4a'), 'x')
  await writeFile(join(root, '컴파일러', DONE_DIR, '9.14 끝난 강의.m4a'), 'c')
  await writeFile(join(root, '.sync', '숨김.m4a'), 'd')
  const files = (await scanWatchFolder(root)).map((f) => [f.subject, f.path.slice(root.length + 1)]).sort()
  assert.deepEqual(files, [
    ['컴파일러', join('컴파일러', '9.21 Lexical.m4a')],
    [null, '메모 녹음.m4a']
  ].sort())
  assert.deepEqual(await subjectDirs(root), ['컴파일러'])
  assert.deepEqual(await scanWatchFolder(join(root, '없는 폴더')), [])
})

test('복사가 끝난 파일만: 앞 폴링과 크기·수정 시각이 같고, 바뀐 지 1분이 지나야 한다', () => {
  const now = 1_000_000
  const f = (path: string, size: number, age: number): WatchFile => ({ path, subject: null, size, mtimeMs: now - age })
  const before = new Map([
    ['a', f('a', 10, MIN_AGE_MS + 1)], // 그대로 → 처리
    ['b', f('b', 5, MIN_AGE_MS + 1)], // 커지는 중
    ['c', f('c', 10, 1000)] // 방금 바뀜
  ])
  const nowFiles = [f('a', 10, MIN_AGE_MS + 1), f('b', 8, MIN_AGE_MS + 1), f('c', 10, 1000), f('d', 10, MIN_AGE_MS + 1)] // d는 처음 봄
  assert.deepEqual(settled(nowFiles, before, now).map((x) => x.path), ['a'])
  assert.deepEqual(settled([f('e', 0, MIN_AGE_MS + 1)], new Map([['e', f('e', 0, MIN_AGE_MS + 1)]]), now), []) // 빈 파일
})

test('같은 녹음은 이름·위치가 바뀌어도 같은 fingerprint, 내용이 다르면 다르다', async () => {
  const dir = await tempDir()
  const big = Buffer.alloc(3 << 20, 7)
  await writeFile(join(dir, 'a.m4a'), big)
  await writeFile(join(dir, 'b.m4a'), big)
  const other = Buffer.from(big)
  other[other.length - 1] = 8 // 끝부분만 다름
  await writeFile(join(dir, 'c.m4a'), other)
  const fp = (n: string) => fingerprint(join(dir, n), big.length)
  assert.equal(await fp('a.m4a'), await fp('b.m4a'))
  assert.notEqual(await fp('a.m4a'), await fp('c.m4a'))
})

test('처리한 녹음과 필기는 처리됨으로 옮기고, 이름이 겹치면 (2)를 붙인다', async () => {
  const dir = join(await tempDir(), '컴파일러')
  await mkdir(join(dir, DONE_DIR), { recursive: true })
  await writeFile(join(dir, DONE_DIR, '9.21 Lexical.m4a'), 'old')
  await writeFile(join(dir, '9.21 Lexical.m4a'), 'new')
  await writeFile(join(dir, '9.21 Lexical.md'), '필기')
  const moved = await moveToDone(join(dir, '9.21 Lexical.m4a'))
  assert.equal(moved.audio, join(dir, DONE_DIR, '9.21 Lexical (2).m4a'))
  assert.equal(moved.notes, join(dir, DONE_DIR, '9.21 Lexical (2).md'))
  assert.ok(!existsSync(join(dir, '9.21 Lexical.m4a')) && !existsSync(join(dir, '9.21 Lexical.md')))
})

test('처리 기록은 없으면 빈 값이고, 저장한 값을 다시 읽는다', async () => {
  const dir = await tempDir()
  assert.deepEqual(await loadWatchState(dir), { seen: {}, baseline: [] })
  const file: WatchFile = { path: 'C:\\w\\a.m4a', subject: null, size: 3, mtimeMs: 12.6 }
  await saveWatchState(dir, { seen: { abc: { path: file.path, at: 't', jobId: 'j' } }, baseline: [baselineKey(file)] })
  const s = await loadWatchState(dir)
  assert.equal(s.seen['abc'].jobId, 'j')
  assert.deepEqual(s.baseline, ['C:\\w\\a.m4a|3|13'])
})
