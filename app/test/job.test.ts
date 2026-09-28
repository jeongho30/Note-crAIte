import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, mock, test } from 'node:test'
import { EngineError } from '../src/core/errors.ts'
import { createJob, listJobs, loadJob, runJob } from '../src/core/job.ts'
import type { JobContext, JobSettings } from '../src/core/job.ts'
import { findFfmpeg } from '../src/core/paths.ts'
import { tempDir, writeWav } from './helpers.ts'

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-whisper-cli.mjs')

function ffmpegOrNull(): string | null {
  try {
    return findFfmpeg()
  } catch {
    return null
  }
}
const FFMPEG = ffmpegOrNull()
const skip = !FFMPEG && 'ffmpeg 필요'

afterEach(() => mock.restoreAll())

function settings(outDir: string, withLlm: boolean): JobSettings {
  return {
    language: 'ko', model: 'large-v3-turbo-q8_0', beamSize: 1, gpuDevice: null, threads: 2, outDir,
    llm: withLlm ? { endpoint: 'https://llm.test/chat/completions/', model: 'gemini-3.8-flash' } : null
  }
}

function context(dir: string, apiKey: string | null, whisperCli = [process.execPath, FAKE]): JobContext {
  return { ffmpeg: FFMPEG!, whisperCli, apiKey, modelPath: async (_kind, name) => join(dir, `${name}.bin`) }
}

/** 가짜 녹음 (이름에 점이 든 경우) */
async function recording(dir: string): Promise<string> {
  const audio = join(dir, '9.14 Lexical Analysis.wav')
  await writeWav(audio, 3)
  return audio
}

test('요약 없이 끝까지: 전사만 담은 노트를 미분류 폴더에 저장하고 조각 WAV를 지운다', { skip }, async () => {
  const dir = await tempDir()
  const jobDir = await createJob(join(dir, 'data'), await recording(dir), null, null, settings(join(dir, 'out'), false))
  const job = await runJob(jobDir, context(dir, null))

  assert.equal(job.status, 'done')
  assert.equal(job.stages.summarize.status, 'skipped')
  assert.ok(job.output!.notePath.startsWith(join(dir, 'out', '미분류')))
  assert.ok(job.output!.notePath.endsWith(' 9.14 Lexical Analysis.md'), job.output!.notePath)
  const md = await readFile(job.output!.notePath, 'utf8')
  assert.match(md, /# 9\.14 Lexical Analysis\n/)
  assert.match(md, /> \[!quote\]- 전사문\n> 안녕하세요 강의를 시작합니다\n/)
  assert.doesNotMatch(md, /## 요약/)
  assert.equal(existsSync(join(jobDir, 'chunks')), false)
})

test('요약이 실패한 뒤 재개하면 STT를 다시 돌리지 않고 요약부터 이어간다', { skip }, async () => {
  const dir = await tempDir()
  const notes = join(dir, '필기.md')
  await writeFile(notes, '용어: 안녕하십니까')
  const jobDir = await createJob(join(dir, 'data'), await recording(dir), notes, '컴파일러', settings(join(dir, 'out'), true))

  mock.method(globalThis, 'fetch', async () => new Response('bad key', { status: 401 }))
  await assert.rejects(runJob(jobDir, context(dir, 'wrong-key')), (e: EngineError) => e.code === 'auth')
  const failed = await loadJob(jobDir)
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.error && { stage: failed.error.stage, code: failed.error.code }, { stage: 'summarize', code: 'auth' })
  assert.equal(failed.stages.stt.status, 'done')
  mock.restoreAll()

  const bodies: string[] = []
  mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body))
    const content = JSON.stringify({
      title: '인사와 강의 시작', summary: '인사를 했다.', keywords: ['인사'],
      corrections: [{ wrong: '안녕하세요', right: '안녕하십니까' }, { wrong: '없는 말', right: 'x' }]
    })
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
  })
  // STT를 다시 돌리면 없는 실행 파일이라 실패한다
  const job = await runJob(jobDir, context(dir, 'good-key', [join(dir, 'no-such-whisper.exe')]))

  assert.equal(job.status, 'done')
  assert.match(bodies[0], /용어: 안녕하십니까/, '작업 폴더에 복사해 둔 필기를 요약에 넘긴다')
  assert.ok(job.output!.notePath.startsWith(join(dir, 'out', '컴파일러')))
  assert.ok(job.output!.notePath.endsWith(' 인사와 강의 시작.md'))
  const md = await readFile(job.output!.notePath, 'utf8')
  assert.match(md, /> \[!quote\]- 전사문\n> 안녕하십니까 강의를 시작합니다\n/)
  assert.match(md, /> \*\*\[00:00\]\*\* 안녕하세요 강의를 시작합니다/, '원문 정리본은 교정 전 그대로')
  assert.match(md, /교정 내역 \(1건\)\n> - 안녕하세요 → 안녕하십니까 \(1회\)/)
})

test('취소하면 cancelled로 남고, 재개하면 그 단계부터 다시 한다', { skip }, async () => {
  const dir = await tempDir()
  const jobDir = await createJob(join(dir, 'data'), await recording(dir), null, null, settings(join(dir, 'out'), false))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runJob(jobDir, { ...context(dir, null), signal: controller.signal }),
                       (e: EngineError) => e.code === 'cancelled')
  const cancelled = await loadJob(jobDir)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.stages.audio.status, 'failed')
  assert.equal((await runJob(jobDir, context(dir, null))).status, 'done')
})

test('listJobs는 넣은 순서(createdAt)대로 돌려준다: 같은 초에 만든 작업도 id 꼬리와 상관없이', async () => {
  const dir = await tempDir()
  const audio = await recording(dir)
  const ids: string[] = []
  for (let i = 0; i < 4; i++) ids.push((await loadJob(await createJob(dir, audio, null, `과목${i}`, settings(dir, false)))).id)
  assert.deepEqual((await listJobs(dir)).map((j) => j.id), ids)
})
