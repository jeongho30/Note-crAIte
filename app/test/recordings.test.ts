import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { probe } from '../src/core/audio.ts'
import { findFfmpeg } from '../src/core/paths.ts'
import {
  finishedPath, finishRecording, isRecording, listRecordings, markProcessed, forgetProcessed, newRecordingPath, recordingName, recordingsDir,
  repairRecordings, unprocessedRecordings, RECORDING_SUFFIX
} from '../src/core/recordings.ts'
import { tempDir, writeWav } from './helpers.ts'

function hasFfmpeg(): boolean {
  try {
    findFfmpeg()
    return true
  } catch {
    return false
  }
}

test('녹음 이름은 시작 시각, 같은 분에 또 녹음하면 (2)', async () => {
  const data = await tempDir()
  const at = new Date(2026, 8, 30, 14, 5)
  assert.equal(recordingName(at), '녹음 2026-09-30 14.05')
  const first = await newRecordingPath(data, at)
  assert.equal(first, join(recordingsDir(data), '녹음 2026-09-30 14.05' + RECORDING_SUFFIX))
  await writeFile(finishedPath(first), 'x')
  assert.equal(await newRecordingPath(data, at), join(recordingsDir(data), '녹음 2026-09-30 14.05 (2)' + RECORDING_SUFFIX))
})

test('끝난 녹음 이름은 접미사만 뗀다 (이름의 점은 그대로)', () => {
  assert.equal(finishedPath(join('r', '녹음 2026-09-30 14.05' + RECORDING_SUFFIX)), join('r', '녹음 2026-09-30 14.05.webm'))
})

test('ffmpeg가 없으면 이름만 바꾸고, 빈 녹음은 지운다', async () => {
  const data = await tempDir()
  const temp = await newRecordingPath(data, new Date(2026, 8, 30, 9, 0))
  await writeFile(temp, 'webm 조각')
  const out = await finishRecording(join(data, '없는-ffmpeg.exe'), temp, new Date())
  assert.equal(out, finishedPath(temp))
  assert.ok(existsSync(out!) && !existsSync(temp))

  const empty = await newRecordingPath(data, new Date(2026, 8, 30, 10, 0))
  await writeFile(empty, '')
  assert.equal(await finishRecording(join(data, '없는-ffmpeg.exe'), empty, new Date()), null)
  assert.ok(!existsSync(empty))
})

test('끝낸 녹음에 길이와 녹음 시작 시각이 들어간다', { skip: !hasFfmpeg() && 'ffmpeg 필요' }, async () => {
  const data = await tempDir()
  const wav = join(data, 'src.wav')
  await writeWav(wav, 3)
  const temp = await newRecordingPath(data, new Date(2026, 8, 30, 11, 0))
  // MediaRecorder처럼 길이 정보 없이 흘려 쓴 webm (파이프로 내보내면 길이를 쓰지 못한다)
  const code = await new Promise((resolve) => {
    const proc = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'libopus', '-f', 'webm', '-'], { stdio: ['ignore', 'pipe', 'inherit'] })
    proc.stdout.pipe(createWriteStream(temp))
    proc.on('close', resolve)
  })
  assert.equal(code, 0)
  const started = new Date('2026-09-30T02:00:00Z')
  const out = await finishRecording(findFfmpeg(), temp, started)
  const info = await probe(findFfmpeg(), out!)
  assert.ok(info.durationS && Math.abs(info.durationS - 3) < 0.2, `길이 ${info.durationS}`)
  assert.equal(new Date(info.creationTime!).getTime(), started.getTime())
  assert.ok(!existsSync(temp))
})

test('남은 녹음 중 파일은 고치되 지금 녹음 중인 파일은 두고, 작업으로 넘긴 녹음은 처리하지 않은 목록에서 빠진다', async () => {
  const data = await tempDir()
  const dir = recordingsDir(data)
  await mkdir(dir, { recursive: true })
  const left = join(dir, '녹음 2026-09-29 10.00' + RECORDING_SUFFIX)
  const active = join(dir, '녹음 2026-09-30 10.00' + RECORDING_SUFFIX)
  await writeFile(left, 'a')
  await writeFile(active, 'b')
  await repairRecordings(join(data, '없는-ffmpeg.exe'), data, active)
  assert.ok(existsSync(active))
  const list = await listRecordings(data)
  assert.deepEqual(list.map((r) => r.name), ['녹음 2026-09-29 10.00.webm'])

  const done = list[0].path
  assert.ok(isRecording(data, done))
  assert.ok(!isRecording(data, active))
  assert.ok(!isRecording(data, join(data, 'x.webm')))
  await markProcessed(data, [done, join(data, '밖.webm')])
  assert.deepEqual(await unprocessedRecordings(data), [])
  await forgetProcessed(data, [done])
  assert.deepEqual((await unprocessedRecordings(data)).map((r) => r.name), ['녹음 2026-09-29 10.00.webm'])
})
