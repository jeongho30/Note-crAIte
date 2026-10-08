// 모델 카탈로그: 앱에 든 것의 형식, 새 모델 찾기, 저장소에서 받아 바꾸기 (받는 것은 꾸민 응답).
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, mock, test } from 'node:test'
import { CATALOG_URL, loadCachedCatalog, refreshCatalog } from '../src/core/catalogsync.ts'
import { EngineError } from '../src/core/errors.ts'
import { BUILTIN, catalog, estimateCredits90, newModels, parseCatalog, setCatalog } from '../src/core/llmcatalog.ts'
import type { Catalog } from '../src/core/llmcatalog.ts'
import { creditsPer90ByModel } from '../src/core/providers.ts'
import { tempDir } from './helpers.ts'

afterEach(() => {
  mock.restoreAll()
  setCatalog(BUILTIN)
})

/** 앱에 든 것보다 하루 뒤에 고친 카탈로그 */
function later(change: Partial<Catalog> = {}): Catalog {
  const next = new Date(`${BUILTIN.updated}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return { ...BUILTIN, updated: next.toISOString().slice(0, 10), ...change }
}

function serve(body: unknown, status = 200): string[] {
  const urls: string[] = []
  mock.method(globalThis, 'fetch', async (url: string) => {
    urls.push(url)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  })
  return urls
}

test('앱에 든 카탈로그: 추천 모델은 모두 단가가 있고, 숨긴 모델과 겹치지 않는다', () => {
  assert.ok(BUILTIN)
  const { prices, ranked, recommendedCount, polishRecommended, hidden } = BUILTIN
  for (const id of [...ranked.map((r) => r.id), ...polishRecommended]) assert.ok(prices[id], id)
  assert.deepEqual(ranked.filter((r) => hidden.includes(r.id)), [])
  assert.ok(recommendedCount <= ranked.length)
})

test('카탈로그 형식이 하나라도 다르면 쓰지 않고, 모르는 필드는 버린다', () => {
  const raw = JSON.parse(JSON.stringify(BUILTIN))
  assert.deepEqual(parseCatalog({ ...raw, later: '나중에 생긴 필드' }), BUILTIN)
  assert.equal(parseCatalog(null), null)
  assert.equal(parseCatalog('<html>'), null)
  assert.equal(parseCatalog({ ...raw, version: 2 }), null)
  assert.equal(parseCatalog({ ...raw, updated: '10/8' }), null)
  assert.equal(parseCatalog({ ...raw, prices: { ...raw.prices, x: { input: '1', output: 2 } } }), null)
  assert.equal(parseCatalog({ ...raw, prices: { ...raw.prices, x: { input: -1, output: 2 } } }), null)
  assert.equal(parseCatalog({ ...raw, ranked: [] }), null)
  assert.equal(parseCatalog({ ...raw, ranked: [{ id: 'a' }] }), null)
  assert.equal(parseCatalog({ ...raw, recommendedCount: raw.ranked.length + 1 }), null)
  assert.equal(parseCatalog({ ...raw, hidden: [1] }), null)
  assert.equal(parseCatalog({ ...raw, summaryCredits90: { a: null } }), null)
})

test('서비스 목록에만 있는 모델은 새 모델이고, 추천 순서나 숨김 목록의 모델은 아니다', () => {
  const ranked = BUILTIN.ranked[0].id
  const hidden = BUILTIN.hidden[0]
  assert.deepEqual(newModels([ranked, 'claude-haiku-9', hidden, 'claude-haiku-9', 'gpt-7-luna']), ['claude-haiku-9', 'gpt-7-luna'])
  assert.deepEqual(newModels([]), [])
})

test('받아 온 카탈로그로 단가·추천·알려진 크레딧이 바뀌고, 데이터 폴더에 남아 다음 실행 때 쓰인다', async () => {
  const dir = await tempDir()
  const next = later({
    prices: { ...BUILTIN.prices, 'claude-haiku-9': { input: 0.1, output: 0.5 } },
    ranked: [{ id: 'claude-haiku-9', note: '새 추천' }, ...BUILTIN.ranked],
    summaryCredits90: { ...BUILTIN.summaryCredits90, 'claude-haiku-9': 4.2 }
  })
  const urls = serve(next)
  assert.equal(estimateCredits90('claude-haiku-9'), null)

  assert.equal(await refreshCatalog(dir), true)
  assert.deepEqual(urls, [CATALOG_URL])
  assert.equal(catalog().ranked[0].id, 'claude-haiku-9')
  assert.equal(estimateCredits90('claude-haiku-9'), estimateCredits90('gpt-6-luna'))
  assert.equal(creditsPer90ByModel([])['claude-haiku-9'], 4.2)
  assert.deepEqual(newModels(['claude-haiku-9']), [])
  assert.equal(await refreshCatalog(dir), false) // 같은 것을 다시 받음

  setCatalog(BUILTIN)
  assert.equal(await loadCachedCatalog(dir), true)
  assert.deepEqual(catalog(), next)
})

test('앱에 든 것보다 오래된 카탈로그는 받아도, 받아 둔 것이어도 쓰지 않는다', async () => {
  const dir = await tempDir()
  const old = { ...BUILTIN, updated: '2026-01-01', ranked: [{ id: '옛-모델', note: '' }], recommendedCount: 1 }
  serve(old)
  assert.equal(await refreshCatalog(dir), false)
  assert.equal(catalog(), BUILTIN)
  await assert.rejects(readFile(join(dir, 'model-catalog.json')))

  await writeFile(join(dir, 'model-catalog.json'), JSON.stringify(old))
  assert.equal(await loadCachedCatalog(dir), false)
  assert.equal(catalog(), BUILTIN)
})

test('카탈로그를 못 받거나 형식이 다르면 던지고 지금 것을 그대로 쓴다', async () => {
  const dir = await tempDir()
  serve('Not Found', 404)
  await assert.rejects(refreshCatalog(dir), (e: unknown) => e instanceof EngineError && e.code === 'network')
  mock.restoreAll()
  serve('<html>점검 중</html>')
  await assert.rejects(refreshCatalog(dir), (e: unknown) => e instanceof EngineError && e.code === 'input')
  mock.restoreAll()
  serve({ ...later(), prices: { x: { input: 'free', output: 0 } } })
  await assert.rejects(refreshCatalog(dir))
  assert.equal(catalog(), BUILTIN)
  assert.equal(await loadCachedCatalog(dir), false) // 받아 둔 것도 없다
})
