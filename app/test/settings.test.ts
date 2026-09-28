import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import { EngineError } from '../src/core/errors.ts'
import { verifyKey } from '../src/core/providers.ts'
import { DEFAULT_SETTINGS, loadSettings, updateSettings } from '../src/core/settings.ts'
import { inspectFolder, useFolder } from '../src/core/vault.ts'
import { tempDir } from './helpers.ts'

test('설정은 없으면 기본값이고, 고친 값만 바뀐 채 저장된다', async () => {
  const dir = join(await tempDir(), 'data') // 데이터 폴더가 아직 없어도 된다
  assert.deepEqual(await loadSettings(dir), DEFAULT_SETTINGS)
  await updateSettings(dir, { wizardStep: 2 })
  await updateSettings(dir, { outDir: 'D:\\notes' })
  assert.deepEqual(await loadSettings(dir), { ...DEFAULT_SETTINGS, wizardStep: 2, outDir: 'D:\\notes' })
})

test('동시에 여러 번 고쳐도 변경이 모두 남는다', async () => {
  const dir = await tempDir()
  const writes = await Promise.all([
    updateSettings(dir, { wizardStep: 1 }),
    updateSettings(dir, { outDir: 'D:\\notes' }),
    updateSettings(dir, { wizardStep: 2 }),
    updateSettings(dir, { provider: 'chatkhu' }),
    updateSettings(dir, { wizardDone: true })
  ])
  const expected = { ...DEFAULT_SETTINGS, wizardStep: 2, wizardDone: true, outDir: 'D:\\notes', provider: 'chatkhu' }
  assert.deepEqual(writes.at(-1), expected)
  assert.deepEqual(await loadSettings(dir), expected)
})

test('깨진 설정 파일은 기본값으로 읽는다', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'settings.json'), '{쓰다 만')
  assert.deepEqual(await loadSettings(dir), DEFAULT_SETTINGS)
})

test('폴더 검사: 하위 폴더가 과목 목록이고, 상위 폴더의 .obsidian으로 볼트를 알아본다', async () => {
  const vault = await tempDir()
  await mkdir(join(vault, '.obsidian'))
  const notes = join(vault, '강의 노트')
  for (const s of ['자료구조', '컴파일러', '.trash']) await mkdir(join(notes, s), { recursive: true })
  await writeFile(join(notes, 'README.md'), '')

  const info = await inspectFolder(notes)
  assert.equal(info.exists, true)
  assert.equal(info.writable, true)
  assert.equal(info.vaultRoot, vault)
  assert.deepEqual(info.subjects, ['자료구조', '컴파일러'], '숨김 폴더와 파일은 빼고 가나다순')
})

test('없는 폴더는 쓰기 여부를 미리 판단하지 않고, useFolder가 만들면서 확인한다', async () => {
  const base = await tempDir()
  const target = join(base, '새 폴더', '9.14 노트') // 이름의 점은 확장자가 아니다
  const before = await inspectFolder(target)
  assert.deepEqual([before.exists, before.writable, before.vaultRoot, before.subjects], [false, null, null, []])
  const after = await useFolder(target)
  assert.deepEqual([after.exists, after.writable], [true, true])
})

test('폴더를 만들 수 없으면 useFolder는 이유를 담은 input 오류를 낸다', async () => {
  const base = await tempDir()
  await writeFile(join(base, '파일'), '')
  await assert.rejects(useFolder(join(base, '파일', '노트')), (e: EngineError) => e.code === 'input' && e.message.startsWith('폴더를 만들지 못했어요('))
})

test('verifyKey: ChatKHU는 크레딧 잔액을 돌려주고, 401은 auth 오류다', async (t) => {
  const seen: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    seen.push(`${url} ${(init.headers as Record<string, string>)['Authorization']}`)
    return new Response(JSON.stringify({ total: { remaining: '3812.5' } }), { status: 200 })
  })
  assert.deepEqual(await verifyKey('chatkhu', 'k-test'), { credits: 3812.5 })
  assert.deepEqual(seen, ['https://factchat-cloud.mindlogic.ai/v1/gateway/credits/ Bearer k-test'])

  mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 401 }))
  await assert.rejects(verifyKey('chatkhu', 'bad'), (e: EngineError) => e.code === 'auth')
  await assert.rejects(verifyKey('openai', 'k'), (e: EngineError) => e.code === 'input', '아직 없는 서비스')
})
