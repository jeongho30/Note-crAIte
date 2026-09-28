import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EngineError } from '../src/core/errors.ts'
import { choose, estimateSttSeconds, parseTimings, parseVulkanDevices } from '../src/core/probe.ts'
import type { Trial } from '../src/core/probe.ts'

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
