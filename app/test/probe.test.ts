import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EngineError } from '../src/core/errors.ts'
import { defaultThreads } from '../src/core/hardware.ts'
import type { Job } from '../src/core/job.ts'
import { join } from 'node:path'
import { choose, estimateJobSeconds, estimateSttSeconds, parseMetalName, parseTimings, parseVulkanDevices, polishRate, probeDevices, sttSpeed, summarySeconds } from '../src/core/probe.ts'
import type { ProbeResult } from '../src/core/probe.ts'
import type { Trial } from '../src/core/probe.ts'
import { tempDir, writeWav } from './helpers.ts'

// 데스크톱(외장 RX 9070 XT + 내장 Radeon)의 실제 whisper-cli 로그 형식
const LOG = [
  'ggml_vulkan: Found 2 Vulkan devices:',
  'ggml_vulkan: 0 = AMD Radeon RX 9070 XT (AMD proprietary driver) | uma: 0 | fp16: 1 | bf16: 1 | warp size: 64',
  'ggml_vulkan: 1 = AMD Radeon(TM) Graphics (AMD proprietary driver) | uma: 1 | fp16: 1 | bf16: 0 | warp size: 32',
  'whisper_backend_init_gpu: using Vulkan0 backend',
  'whisper_print_timings:     load time =   603.27 ms',
  'whisper_print_timings:   encode time =   125.57 ms /     2 runs (    62.79 ms per run)',
  'whisper_print_timings:    total time =  1042.02 ms'
]

function trial(device: number | null, processMs: number, ok = true): Trial {
  return { device, name: device === null ? 'CPU' : `GPU${device}`, processMs, loadMs: 600, chars: 200, ok }
}

test('parseVulkanDevices는 장치 번호·이름·내장 여부를 읽는다', () => {
  assert.deepEqual(parseVulkanDevices(LOG), [
    { index: 0, name: 'AMD Radeon RX 9070 XT (AMD proprietary driver)', integrated: false },
    { index: 1, name: 'AMD Radeon(TM) Graphics (AMD proprietary driver)', integrated: true }
  ])
  assert.deepEqual(parseVulkanDevices(['whisper_backend_init_gpu: no GPU found']), [])
})

test('macOS: 장치 목록 없이 Metal(0번)을 재 보고, 이름은 그 로그에서 읽는다', async (t) => {
  assert.equal(parseMetalName(['ggml_metal_device_init: GPU name:   MTL0 (Apple M2)']), 'Apple M2')
  assert.equal(parseMetalName(LOG), null)

  const dir = await tempDir()
  await writeWav(join(dir, 'in.wav'), 2)
  process.env['FAKE_WHISPER_MODE'] = 'metal'
  t.after(() => delete process.env['FAKE_WHISPER_MODE'])
  const options = {
    cli: [process.execPath, join(import.meta.dirname, 'fixtures', 'fake-whisper-cli.mjs')],
    model: join(dir, 'model.bin'), modelName: 'm', vadModel: join(dir, 'vad.bin'), threads: 2, beamSize: 1, language: 'ko',
    sample: join(dir, 'in.wav'), workDir: join(dir, 'probe')
  }
  const mac = await probeDevices({ ...options, platform: 'darwin' })
  assert.deepEqual(mac.devices, [{ index: 0, name: 'Apple M2', integrated: true }])
  assert.deepEqual(mac.trials.map((x) => [x.device, x.name, x.ok, x.processMs]), [[null, 'CPU', true, 9000], [0, 'Apple M2', true, 1000]])
  assert.equal(mac.gpuDevice, 0)

  // 같은 로그라도 Windows에서는 Vulkan 장치 목록이 없으니 CPU만 잰다
  const win = await probeDevices({ ...options, platform: 'win32' })
  assert.deepEqual(win.trials.map((x) => x.device), [null])
  assert.equal(win.gpuDevice, null)
})

test('defaultThreads: 물리 코어 2개를 남기고, 성능·효율 코어가 나뉜 Mac은 성능 코어만 쓴다', () => {
  const hw = { cpu: 'x', logicalCores: 16, ramGb: 16, gpus: [], powerPlugged: null }
  assert.equal(defaultThreads({ ...hw, physicalCores: 8 }), 6)
  assert.equal(defaultThreads({ ...hw, physicalCores: 2 }), 1)
  assert.equal(defaultThreads({ ...hw, physicalCores: 8, performanceCores: 4 }), 4, 'M1: 성능 4 + 효율 4')
})

test('parseTimings는 로드·전체 시간을 읽는다', () => {
  assert.deepEqual(parseTimings(LOG), { loadMs: 603.27, totalMs: 1042.02 })
  assert.deepEqual(parseTimings([]), { loadMs: null, totalMs: null })
})

test('choose는 정상인 GPU 중 가장 빠른 것을, CPU보다 충분히 빠를 때만 고른다', () => {
  assert.equal(choose([trial(null, 9800), trial(0, 440), trial(1, 30000)]).device, 0)
  assert.equal(choose([trial(null, 9800), trial(0, 440, false), trial(1, 5000)]).device, 1, '깨진 GPU는 건너뛴다')
  assert.equal(choose([trial(null, 1000), trial(0, 900)]).device, null, '1.2배보다 덜 빠르면 CPU')
  assert.equal(choose([trial(null, 1000)]).device, null)
  assert.throws(() => choose([trial(null, 0, false)]), (e: EngineError) => e.code === 'stt_failed')
})

test('estimateSttSeconds는 처리 속도에 조각마다 모델 로드를 더한다', () => {
  // 90분, RTF 0.3, 조각 9개 × 로드 2초
  assert.equal(estimateSttSeconds(5400, { rtf: 0.3, loadS: 2 }), 5400 * 0.3 + 9 * 2)
})

test('estimateJobSeconds는 받아쓰기에 오디오 준비와 요약(할 때만)을 더한다', () => {
  const p = { rtf: 0.3, loadS: 2 }
  const stt = estimateSttSeconds(5400, p)
  assert.equal(estimateJobSeconds(5400, p, 0), stt + 3) // 90분 오디오 준비 3초
  assert.equal(estimateJobSeconds(5400, p, 25), stt + 3 + 25)
  // 전사문 다듬기를 하면 그 시간도 더한다 (녹음 길이 × 다듬기 속도)
  assert.equal(estimateJobSeconds(5400, p, 25, 0.05), stt + 3 + 270 + 25)
})

test('polishRate는 같은 주소·모델로 끝낸 다듬기 기록의 중앙값을 쓰고, 없으면 로컬·서비스 기본값을 쓴다', () => {
  const local = { endpoint: 'http://127.0.0.1:11434/api/chat', model: 'gemma', ollama: {} }
  const service = { endpoint: 'https://x/chat', model: 'gpt-6-luna' }
  const job = (target: object, durationS: number, tookS: number, extra: object = {}): never =>
    ({ settings: { polishLlm: target }, audio: { durationS }, stages: { polish: { status: 'done', startedAt: '2026-10-04T00:00:00Z', endedAt: new Date(Date.parse('2026-10-04T00:00:00Z') + tookS * 1000).toISOString(), ...extra } } }) as never
  assert.equal(polishRate([], null), 0)
  assert.equal(polishRate([], local), 0.05)
  assert.equal(polishRate([], service), 0.02)
  const jobs = [job(local, 3000, 90), job(local, 3000, 150), job(local, 3000, 120), job(service, 3000, 30), job(local, 3000, 5, { resumed: true }), job(local, 100, 50)]
  assert.equal(polishRate(jobs, local), 0.04) // 90·120·150초의 중앙값 ÷ 3000. 이어서 한 것과 5분보다 짧은 녹음은 뺀다
  assert.equal(polishRate(jobs, service), 0.01)
  assert.equal(polishRate(jobs, { ...local, model: '다른 모델' }), 0.05)
})

test('summarySeconds는 같은 주소·모델로 끝낸 요약 시간의 중앙값을 쓰고, 없으면 로컬·서비스 기본값을 쓴다', () => {
  const local = { endpoint: 'http://127.0.0.1:11434/api/chat', model: 'gemma', ollama: {} }
  const service = { endpoint: 'https://x/chat', model: 'gpt-6-luna' }
  const job = (target: object, tookS: number, extra: object = {}): never =>
    ({ settings: { llm: target }, stages: { summarize: { status: 'done', startedAt: '2026-10-04T00:00:00Z', endedAt: new Date(Date.parse('2026-10-04T00:00:00Z') + tookS * 1000).toISOString(), ...extra } } }) as never
  assert.equal(summarySeconds([], null), 0)
  assert.equal(summarySeconds([], service), 25)
  assert.equal(summarySeconds([], local), 90)
  const jobs = [job(service, 16), job(service, 30), job(service, 24), job(local, 200), job(service, 500, { resumed: true })]
  assert.equal(summarySeconds(jobs, service), 24) // 이어서 한 요약은 뺀다
  assert.equal(summarySeconds(jobs, local), 200)
})

test('sttSpeed는 같은 설정으로 끝낸 작업의 실제 속도를 쓰고, 없으면 잰 속도를 낮춰 쓴다', () => {
  const probe = { model: 'm', gpuDevice: null, threads: 6, rtf: 0.6, loadS: 2 } as ProbeResult
  const job = (tookS: number, durationS: number, over: Record<string, unknown> = {}, stage: Record<string, unknown> = {}): Job =>
    ({
      settings: { model: 'm', gpuDevice: null, threads: 6, args: null, ...over },
      audio: { durationS },
      stages: { stt: { status: 'done', startedAt: new Date(0).toISOString(), endedAt: new Date(tookS * 1000).toISOString(), ...stage } }
    }) as unknown as Job

  // 기록이 없으면 잰 값 × 0.65, 모델 로드는 그대로
  assert.deepEqual(sttSpeed(probe, [], null), { rtf: 0.6 * 0.65, loadS: 2 })

  // 기록이 있으면 중앙값, 모델 로드는 기록에 들어 있어 0
  assert.deepEqual(sttSpeed(probe, [job(1000, 5000), job(2000, 5000), job(1500, 5000)], null), { rtf: 0.3, loadS: 0 })
  assert.equal(sttSpeed(probe, [job(1000, 4000), job(3000, 4000)], null).rtf, 0.5)

  // 최근 5개만
  const old = [job(4000, 5000), job(4000, 5000)]
  assert.equal(sttSpeed(probe, [...old, ...Array.from({ length: 5 }, () => job(1000, 5000))], null).rtf, 0.2)

  // 다른 모델·장치·스레드·옵션, 이어서 한 것, 짧은 녹음, ChatKHU 받아쓰기, 끝나지 않은 것은 뺀다
  const skipped = [
    job(100, 5000, { model: 'other' }),
    job(100, 5000, { gpuDevice: 0 }),
    job(100, 5000, { threads: 4 }),
    job(100, 5000, { args: ['-bs', '5'] }),
    job(100, 5000, {}, { resumed: true }),
    job(10, 120),
    job(100, 5000, { sttService: 'chatkhu' }),
    job(100, 5000, {}, { status: 'failed' })
  ]
  assert.deepEqual(sttSpeed(probe, skipped, null), { rtf: 0.6 * 0.65, loadS: 2 })
  assert.equal(sttSpeed(probe, skipped, ['-bs', '5']).rtf, 0.02)
})
