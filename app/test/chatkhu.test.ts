import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { findFfmpeg } from '../src/core/paths.ts'
import { chargedCredits, ChatkhuStt, chatkhuSttCredits, splitSegments } from '../src/core/stt/chatkhu.ts'
import { tempDir, writeWav } from './helpers.ts'

function hasFfmpeg(): boolean {
  try {
    findFfmpeg()
    return true
  } catch {
    return false
  }
}

test('긴 화자 구간은 문장 끝에서 나누고 시각은 글자 위치로 나눈다', () => {
  const out = splitSegments([{ speaker: 'Speaker 1', text: '가나다. 라마바사아?', start_ms: 1000, end_ms: 2200 }, { text: ' ', start_ms: 3000, end_ms: 4000 }])
  assert.deepEqual(out, [
    { startMs: 1000, endMs: 1545, text: '가나다.' },
    { startMs: 1545, endMs: 2200, text: '라마바사아?' }
  ])
})

test('받아쓰기 크레딧 어림은 1분에 6', () => {
  assert.equal(chatkhuSttCredits(5400), 540)
})

/** 가짜 ChatKHU: 올리면 operation_id, 상태를 처음 물으면 processing, 다음엔 status의 결과 */
async function fakeServer(status: 'completed' | 'failed' | 402) {
  const calls = { upload: 0, poll: 0 }
  const server = createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    req.resume()
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer key') return send(401, {})
      if (req.method === 'POST') {
        calls.upload++
        if (status === 402) return send(402, { error: 'credits' })
        return send(200, { operation_id: `soniox:${calls.upload}`, status: 'processing', duration_seconds: 2, credits_charged: 0.2 })
      }
      calls.poll++
      if (calls.poll === 1) return send(200, { status: 'processing' })
      if (status === 'failed') return send(200, { status: 'failed', error: '엔진 오류' })
      send(200, { status: 'completed', text: '안녕하세요. 시작합니다.', segments: [{ speaker: 'Speaker 1', text: '안녕하세요. 시작합니다.', start_ms: 0, end_ms: 2000 }] })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, calls, close: () => server.close() }
}

test('올리고 끝날 때까지 물어 구간을 받는다. 다시 부르면 다시 올리지 않는다', { skip: !hasFfmpeg() && 'ffmpeg 필요' }, async () => {
  const dir = await tempDir()
  const wav = join(dir, 'part_000.wav')
  await writeWav(wav, 2)
  const s = await fakeServer('completed')
  try {
    const engine = new ChatkhuStt({ base: s.base, apiKey: 'key', ffmpeg: findFfmpeg(), workDir: dir })
    const first = await engine.transcribe(wav, { language: 'ko' })
    assert.deepEqual(first.map((x) => x.text), ['안녕하세요.', '시작합니다.'])
    assert.equal(s.calls.upload, 1)
    assert.ok(!existsSync(join(dir, 'part_000.wav.ogg')), '임시 opus는 지운다')
    await engine.transcribe(wav, { language: 'ko' })
    assert.equal(s.calls.upload, 1, '올린 기록이 있으면 결과만 다시 받는다')
    assert.equal(await chargedCredits(dir), 0.2)
  } finally {
    s.close()
  }
})

test('서버에서 실패한 조각은 기록을 남기고 다음에 다시 올린다, 크레딧 부족은 credits', { skip: !hasFfmpeg() && 'ffmpeg 필요' }, async () => {
  const dir = await tempDir()
  const wav = join(dir, 'part_000.wav')
  await writeWav(wav, 2)
  const failed = await fakeServer('failed')
  try {
    const engine = new ChatkhuStt({ base: failed.base, apiKey: 'key', ffmpeg: findFfmpeg(), workDir: dir })
    await assert.rejects(engine.transcribe(wav, { language: 'ko' }), { code: 'stt_failed' })
    assert.ok((await readdir(dir)).some((f) => /\.op\.json\.failed-\d+$/.test(f)))
    assert.equal(await chargedCredits(dir), 0.2, '실패한 조각의 크레딧도 센다')
  } finally {
    failed.close()
  }
  const poor = await fakeServer(402)
  try {
    const engine = new ChatkhuStt({ base: poor.base, apiKey: 'key', ffmpeg: findFfmpeg(), workDir: dir })
    await assert.rejects(engine.transcribe(wav, { language: 'ko' }), { code: 'credits' })
  } finally {
    poor.close()
  }
})
