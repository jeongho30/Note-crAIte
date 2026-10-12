import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Job } from '../src/core/job.ts'
import { jobSummary, probeSummary } from '../src/core/joblog.ts'
import type { ProbeResult } from '../src/core/probe.ts'

const at = (s: number): string => new Date(Date.UTC(2026, 9, 12, 0, 0, s)).toISOString()

function job(patch: Partial<Job> = {}): Job {
  return {
    id: '20261012-090000-ab12',
    createdAt: at(0),
    input: { audio: 'C:/녹음/10.12 컴파일러.m4a', notes: 'notes.md', subject: '컴파일러' },
    settings: {
      language: 'ko', model: 'large-v3-turbo-q8_0', beamSize: 1, gpuDevice: 0, threads: 6, outDir: 'C:/노트',
      llm: { endpoint: 'https://example.invalid/v1', model: 'gpt-6-luna', service: 'chatkhu' },
      polishLlm: { endpoint: 'http://127.0.0.1:11434', model: 'gemma', ollama: {} as never }
    },
    stages: {
      audio: { status: 'done', startedAt: at(0), endedAt: at(2) },
      stt: { status: 'done', startedAt: at(2), endedAt: at(302) },
      clean: { status: 'done', startedAt: at(302), endedAt: at(302) },
      polish: { status: 'done', startedAt: at(302), endedAt: at(362) },
      summarize: { status: 'done', startedAt: at(362), endedAt: at(390) },
      note: { status: 'done', startedAt: at(390), endedAt: at(390) },
      save: { status: 'done', startedAt: at(390), endedAt: at(391) }
    },
    status: 'done',
    audio: { durationS: 3000, recordedAt: at(0), chunks: [] },
    usage: { summary: { input: 20000, output: 3000 } },
    polish: { chunks: 12, fallbackChunks: 1 },
    output: { notePath: 'C:/노트/컴파일러/2026-10-12 구문 분석.md' },
    ...patch
  }
}

test('jobSummary는 설정·단계별 시간·예상 시간을 담고 파일 이름과 경로는 담지 않는다', () => {
  const s = jobSummary(job(), { gpuName: 'RX 9070 XT', expected: { sttS: 280, totalS: 370, from: 'history' }, onBattery: { start: true, end: false } })
  assert.deepEqual(s.onBattery, { start: true, end: false })
  assert.deepEqual(s.stt, { service: 'whisper', model: 'large-v3-turbo-q8_0', device: 'gpu0', gpuName: 'RX 9070 XT', threads: 6, beamSize: 1, args: null })
  assert.deepEqual(s.stageS, { audio: 2, stt: 300, clean: 0, polish: 60, summarize: 28, note: 0, save: 1 })
  assert.equal(s.totalS, 391)
  assert.equal(s.sttRtf, 0.1)
  assert.deepEqual(s.expected, { sttS: 280, totalS: 370, from: 'history' })
  assert.deepEqual(s.polish, { service: 'ollama', model: 'gemma' })
  assert.deepEqual(s.summary, { service: 'chatkhu', model: 'gpt-6-luna' })
  assert.equal(s.polishFallback, 1)
  const line = JSON.stringify(s)
  for (const secret of ['컴파일러', '구문 분석', '녹음', 'example.invalid']) assert.ok(!line.includes(secret), secret)
})

test('jobSummary: 이어서 한 받아쓰기는 속도를 적지 않고, 실패는 단계와 코드만 남긴다', () => {
  const j = job({ status: 'failed', error: { code: 'timeout', message: 'C:/녹음/10.12 컴파일러.m4a 요약 시간 초과', stage: 'summarize' } })
  j.stages.stt.resumed = true
  j.stages.summarize = { status: 'failed', startedAt: at(362) }
  const s = jobSummary(j, { continued: true })
  assert.equal(s.sttRtf, null)
  assert.deepEqual(s.resumed, ['stt'])
  assert.equal(s.continued, true)
  assert.deepEqual(s.error, { stage: 'summarize', code: 'timeout' })
  assert.equal((s.stageS as Record<string, number>).summarize, undefined)
  assert.ok(!JSON.stringify(s).includes('컴파일러'))
})

test('jobSummary: ChatKHU 받아쓰기는 이 PC의 모델·장치를 적지 않는다', () => {
  const j = job()
  j.settings.sttService = 'chatkhu'
  assert.deepEqual(jobSummary(j).stt, { service: 'chatkhu' })
})

test('probeSummary는 장치마다 걸린 시간·CER·안 쓴 이유와 재지 않은 장치를 남긴다', () => {
  const p: ProbeResult = {
    checkedAt: at(0), model: 'small-q5_1', threads: 3, sampleS: 39.04,
    devices: [{ index: 0, name: 'Intel UHD', integrated: true }, { index: 1, name: 'RTX 4060', integrated: false }],
    trials: [
      { device: null, name: 'CPU', processMs: 7000, loadMs: 300, chars: 200, ok: true },
      { device: 1, name: 'RTX 4060', processMs: 1234, loadMs: 800, chars: 200, ok: true, cer: 0.0123 }
    ],
    gpuDevice: 1, rtf: 1.234 / 39.04, loadS: 0.8
  }
  const s = probeSummary(p)
  assert.equal(s.chosen, 'gpu1')
  assert.deepEqual(s.trials, [
    { device: 'cpu', name: 'CPU', ok: true, processS: 7, loadS: 0.3 },
    { device: 'gpu1', name: 'RTX 4060', integrated: false, ok: true, processS: 1.23, loadS: 0.8, cer: 0.012 }
  ])
  assert.deepEqual(s.skipped, ['Intel UHD'])
})
