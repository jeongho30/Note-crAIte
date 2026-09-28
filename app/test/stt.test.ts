import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Chunk } from '../src/core/audio.ts'
import { EngineError } from '../src/core/errors.ts'
import { writeJsonAtomic } from '../src/core/files.ts'
import { transcribeChunks } from '../src/core/stt/base.ts'
import type { Segment, SttEngine, TranscribeOptions } from '../src/core/stt/base.ts'
import { WhisperCpp } from '../src/core/stt/whispercpp.ts'
import { tempDir } from './helpers.ts'

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-whisper-cli.mjs')

const CHUNKS: Chunk[] = [
  { file: 'part_000.wav', startS: 0, endS: 600 },
  { file: 'part_001.wav', startS: 600, endS: 1200 }
]

class FakeEngine implements SttEngine {
  calls: string[] = []

  async transcribe(wav: string, opts: TranscribeOptions): Promise<Segment[]> {
    const name = wav.split(/[\\/]/).at(-1)!
    this.calls.push(name)
    opts.onProgress?.(0.5)
    return [{ startMs: 1000, endMs: 2000, text: name }]
  }
}

test('transcribeChunks는 조각 시작만큼 밀어 합치고 진행률을 알린다', async () => {
  const dir = await tempDir()
  const progress: number[] = []
  const merged = await transcribeChunks(new FakeEngine(), CHUNKS, join(dir, 'chunks'), join(dir, 'stt'), {
    language: 'ko',
    onProgress: (f) => progress.push(f)
  })
  assert.deepEqual(merged, [
    { startMs: 1000, endMs: 2000, text: 'part_000.wav' },
    { startMs: 601000, endMs: 602000, text: 'part_001.wav' }
  ])
  assert.deepEqual(progress, [0.25, 0.5, 0.75, 1])
})

test('transcribeChunks는 끝난 조각을 다시 돌리지 않는다', async () => {
  const dir = await tempDir()
  await mkdir(join(dir, 'stt'))
  await writeJsonAtomic(join(dir, 'stt', 'part_000.json'), [{ startMs: 0, endMs: 10, text: '이미 끝남' }])
  const engine = new FakeEngine()
  const merged = await transcribeChunks(engine, CHUNKS, join(dir, 'chunks'), join(dir, 'stt'), { language: 'ko' })
  assert.deepEqual(engine.calls, ['part_001.wav'])
  assert.equal(merged[0].text, '이미 끝남')
  assert.ok(existsSync(join(dir, 'stt', 'part_001.json')))
})

async function makeEngine(dir: string, gpuDevice: number | null = null): Promise<WhisperCpp> {
  const model = join(dir, 'models', 'ggml-test.bin')
  await mkdir(join(dir, 'models'), { recursive: true })
  await writeFile(model, '')
  return new WhisperCpp({ cli: [process.execPath, FAKE], model, vadModel: null, threads: 2, gpuDevice })
}

async function makeWav(dir: string): Promise<string> {
  const wav = join(dir, 'jobs', 'part_000.wav')
  await mkdir(join(dir, 'jobs'), { recursive: true })
  await writeFile(wav, '')
  return wav
}

test('WhisperCpp는 stdout을 버려 멈추지 않고 진행률을 읽는다', { timeout: 30_000 }, async () => {
  const dir = await tempDir()
  const progress: number[] = []
  const segments = await (await makeEngine(dir)).transcribe(await makeWav(dir), {
    language: 'ko',
    onProgress: (f) => progress.push(f)
  })
  assert.deepEqual(segments, [
    { startMs: 0, endMs: 1500, text: '안녕하세요' },
    { startMs: 2000, endMs: 3000, text: '강의를 시작합니다' }
  ])
  assert.equal(progress[0], 0)
  assert.equal(progress.at(-1), 1)
})

test('WhisperCpp 명령은 상대 경로와 장치 옵션을 쓴다', async () => {
  const dir = await tempDir()
  const engine = await makeEngine(dir)
  const wav = join(dir, 'jobs', 'part_000.wav')
  const cmd = engine.command(wav, 'ko')
  assert.equal(cmd[cmd.indexOf('-m') + 1], join('..', 'models', 'ggml-test.bin'))
  assert.equal(cmd[cmd.indexOf('-f') + 1], 'part_000.wav')
  assert.equal(cmd[cmd.indexOf('-mc') + 1], '0')
  assert.ok(cmd.includes('-ng') && !cmd.includes('-dev'))
  assert.ok(cmd.includes('-np'))

  engine.opts.quiet = false
  assert.ok(!engine.command(wav, 'ko').includes('-np'))

  assert.ok(!cmd.includes('-bs')) // 기본은 whisper-cli의 beam search
  engine.opts.beamSize = 1
  assert.equal(engine.command(wav, 'ko')[engine.command(wav, 'ko').indexOf('-bs') + 1], '1')

  engine.opts.gpuDevice = 1
  const gpu = engine.command(wav, 'ko')
  assert.equal(gpu[gpu.indexOf('-dev') + 1], '1')
  assert.ok(!gpu.includes('-ng'))
})

test('WhisperCpp 실패는 stderr 끝부분과 함께 stt_failed', async (t) => {
  const dir = await tempDir()
  process.env['FAKE_WHISPER_MODE'] = 'fail'
  t.after(() => delete process.env['FAKE_WHISPER_MODE'])
  await assert.rejects((await makeEngine(dir)).transcribe(await makeWav(dir), { language: 'ko' }), (e: EngineError) => {
    assert.equal(e.code, 'stt_failed')
    assert.match(e.message, /failed to load model/)
    return true
  })
})

test('WhisperCpp 취소는 프로세스를 끝낸다', { timeout: 30_000 }, async (t) => {
  const dir = await tempDir()
  process.env['FAKE_WHISPER_MODE'] = 'hang'
  t.after(() => delete process.env['FAKE_WHISPER_MODE'])
  const started = Date.now()
  await assert.rejects(
    (await makeEngine(dir)).transcribe(await makeWav(dir), { language: 'ko', signal: AbortSignal.timeout(500) }),
    (e: EngineError) => e.code === 'cancelled'
  )
  assert.ok(Date.now() - started < 10_000)
})
