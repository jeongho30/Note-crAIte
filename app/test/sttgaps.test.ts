import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fillGaps, sparseSegments, transcribeChunks } from '../src/core/stt/base.ts'
import type { Segment, SttEngine } from '../src/core/stt/base.ts'
import { stripVadArgs, WhisperCpp } from '../src/core/stt/whispercpp.ts'
import { tempDir } from './helpers.ts'

const seg = (s: number, e: number, text: string): Segment => ({ startMs: s * 1000, endMs: e * 1000, text })

test('sparseSegments는 60초 넘는데 60자 미만인 구간만 고른다', () => {
  const segs = [seg(0, 5, '안녕하세요'), seg(5, 450, '그래서요'), seg(450, 520, '가'.repeat(80)), seg(520, 540, '짧음')]
  assert.deepEqual(sparseSegments(segs), [segs[1]])
})

test('fillGaps는 누락 구간만 VAD 없이 받아쓴 구간으로 바꾼다', () => {
  const withVad = [seg(0, 5, 'A'), seg(5, 450, '그래서요'), seg(450, 460, 'B')]
  const withoutVad = [seg(0, 5, 'a'), seg(6, 20, '빠졌던 말 1'), seg(200, 230, '빠졌던 말 2'), seg(450, 460, 'b')]
  assert.deepEqual(fillGaps(withVad, [withVad[1]], withoutVad).map((s) => s.text), ['A', '빠졌던 말 1', '빠졌던 말 2', 'B'])
})

class FakeEngine implements SttEngine {
  calls = 0
  result: Segment[]
  plain: FakeEngine | null
  constructor(result: Segment[], plain: FakeEngine | null) {
    this.result = result
    this.plain = plain
  }
  async transcribe(): Promise<Segment[]> {
    this.calls++
    return this.result
  }
  withoutVad(): SttEngine | null {
    return this.plain
  }
}

test('transcribeChunks는 누락 구간이 있는 조각만 VAD 없이 다시 받아써 합친다', async () => {
  const dir = await tempDir()
  await mkdir(join(dir, 'chunks'))
  const plain = new FakeEngine([seg(10, 30, '되살린 말')], null)
  const engine = new FakeEngine([seg(0, 5, '처음'), seg(5, 500, '음')], plain)
  const chunks = [{ file: 'part_000.wav', startS: 0, endS: 600 }, { file: 'part_001.wav', startS: 600, endS: 1200 }]
  const out = await transcribeChunks(engine, chunks, join(dir, 'chunks'), join(dir, 'stt'), { language: 'ko' })
  assert.deepEqual(out.map((s) => s.text), ['처음', '되살린 말', '처음', '되살린 말'])
  assert.equal(out[3].startMs, 610_000, '조각 시작 시각만큼 민다')
  assert.equal(plain.calls, 2)

  const clean = new FakeEngine([seg(0, 5, '정상')], plain)
  await transcribeChunks(clean, chunks, join(dir, 'chunks'), join(dir, 'stt2'), { language: 'ko' })
  assert.equal(plain.calls, 2, '누락 구간이 없으면 다시 받아쓰지 않는다')
})

test('withoutVad는 VAD를 뺀 명령을 만들고, 고친 옵션에서는 VAD 옵션만 뺀다', () => {
  const base = { cli: ['whisper-cli'], model: 'C:/m/model.bin', vadModel: 'C:/m/vad.bin', threads: 4, gpuDevice: null, beamSize: 1 }
  const cmd = new WhisperCpp(base).withoutVad()!.command('C:/w/part_000.wav', 'ko')
  assert.ok(!cmd.includes('--vad') && !cmd.includes('-vm'))
  assert.ok(cmd.includes('-mc') && cmd.includes('-ng'))
  assert.equal(new WhisperCpp({ ...base, vadModel: null }).withoutVad(), null, 'VAD를 안 쓰면 다시 받아쓸 것이 없다')
  assert.deepEqual(stripVadArgs(['-t', '4', '--vad', '-vt', '0.3', '-mc', '0', '--vad-max-speech-duration-s', '30']), ['-t', '4', '-mc', '0'])
})
