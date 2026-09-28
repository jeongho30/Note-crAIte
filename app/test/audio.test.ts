import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseProbe, parseSilences, planChunks, prepareLocal } from '../src/core/audio.ts'
import { findFfmpeg } from '../src/core/paths.ts'
import { splitWav, wavDuration, wavHeader, wavInfo } from '../src/core/wav.ts'
import { tempDir, writeWav } from './helpers.ts'

const PROBE_M4A = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'lecture.m4a':
  Metadata:
    major_brand     : mp42
    creation_time   : 2026-09-22T05:20:11.000000Z
  Duration: 01:17:17.45, start: 0.000000, bitrate: 128 kb/s
  Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, mono, fltp, 127 kb/s (default)
      Metadata:
        creation_time   : 2026-09-22T05:20:12.000000Z
At least one output file must be specified
`

function hasFfmpeg(): boolean {
  try {
    findFfmpeg()
    return true
  } catch {
    return false
  }
}

test('parseProbe는 길이와 컨테이너의 녹음 시각을 읽는다', () => {
  const info = parseProbe(PROBE_M4A)
  assert.ok(Math.abs(info.durationS! - 4637.45) < 1e-6)
  assert.equal(info.creationTime, '2026-09-22T05:20:11.000000Z')
  assert.equal(info.hasAudio, true)
})

test('parseProbe는 길이·오디오가 없으면 null과 false', () => {
  const info = parseProbe("Input #0, image2, from 'x.png':\n  Duration: N/A\n  Stream #0:0: Video: png\n")
  assert.deepEqual(info, { durationS: null, creationTime: null, hasAudio: false })
})

test('parseSilences는 시작과 끝을 짝짓는다', () => {
  const stderr =
    '[silencedetect @ 0000] silence_start: -0.0013\n' +
    '[silencedetect @ 0000] silence_end: 1.5 | silence_duration: 1.5013\n' +
    '[silencedetect @ 0000] silence_start: 598.2\r\n' +
    '[silencedetect @ 0000] silence_end: 599.9 | silence_duration: 1.7\n'
  assert.deepEqual(parseSilences(stderr), [[0, 1.5], [598.2, 599.9]])
})

test('planChunks는 목표 지점 근처에서 가장 긴 무음을 자른다', () => {
  const silences: [number, number][] = [[590, 590.5], [605, 607], [640, 650]] // 마지막은 창(±30초) 밖
  assert.deepEqual(planChunks(1300, silences), [[0, 606], [606, 1300]])
})

test('planChunks는 무음이 없으면 목표 지점에서 자르고 마지막 조각을 길게 둔다', () => {
  assert.deepEqual(planChunks(2000, []), [[0, 600], [600, 1200], [1200, 2000]])
  assert.deepEqual(planChunks(800, []), [[0, 800]])
})

test('splitWav는 프레임을 빠짐없이 나눈다', async () => {
  const dir = await tempDir()
  const src = join(dir, 'input.wav')
  await writeWav(src, 5)
  const outs = [join(dir, 'part_000.wav'), join(dir, 'part_001.wav')]
  await splitWav(src, [[0, 2], [2, 5]], outs)
  assert.deepEqual(await Promise.all(outs.map(wavDuration)), [2, 3])
})

test('wavInfo는 fmt와 data 사이의 LIST 청크를 건너뛴다 (ffmpeg 출력 형태)', async () => {
  const dir = await tempDir()
  const plain = join(dir, 'plain.wav')
  await writeWav(plain, 1)
  const bytes = await readFile(plain)
  const fmtEnd = 12 + 8 + 16
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')])
  const withList = Buffer.concat([bytes.subarray(0, fmtEnd), list, bytes.subarray(fmtEnd)])
  withList.writeUInt32LE(withList.length - 8, 4)
  const path = join(dir, 'list.wav')
  await writeFile(path, withList)
  const info = await wavInfo(path)
  assert.equal(info.dataOffset, fmtEnd + list.length + 8)
  assert.equal(await wavDuration(path), 1)
  assert.equal(wavHeader(info.fmt, 0).length, 44)
})

test('prepareLocal은 조각을 만들고 전체 WAV를 지운다', { skip: !hasFfmpeg() && 'ffmpeg 필요' }, async () => {
  const dir = await tempDir()
  const src = join(dir, 'rec.wav')
  await writeWav(src, 5) // 전부 무음 → 목표 지점 근처 무음 가운데(2.5초)에서 자름
  const chunks = await prepareLocal(findFfmpeg(), src, join(dir, 'job'), 2)
  assert.deepEqual(chunks.map((c) => c.file), ['part_000.wav', 'part_001.wav'])
  assert.equal(chunks[0].startS, 0)
  assert.ok(Math.abs(chunks.at(-1)!.endS - 5) < 1e-3)
  assert.equal(existsSync(join(dir, 'job', 'input.wav')), false)
})
