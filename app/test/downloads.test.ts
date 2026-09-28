import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { download } from '../src/core/downloads.ts'
import { EngineError } from '../src/core/errors.ts'
import { tempDir } from './helpers.ts'

const PAYLOAD = Buffer.from(Uint8Array.from({ length: 256 * 4096 }, (_, i) => i % 256)) // 1MB
const SHA = createHash('sha256').update(PAYLOAD).digest('hex')

const server = { url: '', ranges: [] as (string | undefined)[], ignoreRange: false }
const http = createServer((req, res) => {
  const range = req.headers.range
  server.ranges.push(range)
  if (range && !server.ignoreRange) {
    const start = Number(range.replace('bytes=', '').split('-')[0])
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
      'Content-Length': PAYLOAD.length - start
    })
    res.end(PAYLOAD.subarray(start))
  } else {
    res.writeHead(200, { 'Content-Length': PAYLOAD.length })
    res.end(PAYLOAD)
  }
})

before(async () => {
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  server.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/model.bin`
})
after(() => http.close())
beforeEach(() => {
  server.ranges = []
  server.ignoreRange = false
})

test('처음부터 받는다', async () => {
  const dir = await tempDir()
  const dest = join(dir, 'model.bin')
  assert.equal(await download(server.url, dest, PAYLOAD.length, SHA), dest)
  assert.ok(PAYLOAD.equals(await readFile(dest)))
  assert.equal(existsSync(dest + '.part'), false)
})

test('.part가 있으면 Range로 이어받는다', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'model.bin.part'), PAYLOAD.subarray(0, 1000))
  await download(server.url, join(dir, 'model.bin'), PAYLOAD.length, SHA)
  assert.deepEqual(server.ranges, ['bytes=1000-'])
  assert.ok(PAYLOAD.equals(await readFile(join(dir, 'model.bin'))))
})

test('서버가 Range를 무시하면 처음부터 다시 받는다', async () => {
  const dir = await tempDir()
  server.ignoreRange = true
  await writeFile(join(dir, 'model.bin.part'), 'garbage'.repeat(100))
  await download(server.url, join(dir, 'model.bin'), PAYLOAD.length, SHA)
  assert.ok(PAYLOAD.equals(await readFile(join(dir, 'model.bin'))))
})

test('해시가 다르면 .part를 지우고 download 오류', async () => {
  const dir = await tempDir()
  await assert.rejects(download(server.url, join(dir, 'model.bin'), PAYLOAD.length, '0'.repeat(64)),
                       (e: EngineError) => e.code === 'download')
  assert.equal(existsSync(join(dir, 'model.bin.part')), false)
  assert.equal(existsSync(join(dir, 'model.bin')), false)
})

test('이미 받은 파일은 네트워크 없이 돌려준다', async () => {
  const dir = await tempDir()
  const dest = join(dir, 'model.bin')
  await writeFile(dest, PAYLOAD)
  assert.equal(await download('http://127.0.0.1:9/unreachable', dest, PAYLOAD.length, SHA), dest)
})

test('연결 실패는 network 오류', async () => {
  const dir = await tempDir()
  await assert.rejects(download('http://127.0.0.1:9/unreachable', join(dir, 'x.bin'), 10, SHA),
                       (e: EngineError) => e.code === 'network')
})
