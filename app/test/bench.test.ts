import assert from 'node:assert/strict'
import { test } from 'node:test'
import { textInRange } from '../src/cli/bench.ts'
import { cer, normalize } from '../src/core/compare.ts'
import { backendUsed } from '../src/core/stt/whispercpp.ts'

test('normalize는 띄어쓰기·문장부호를 무시한다', () => {
  assert.equal(normalize('안녕 하세요, AI 강의!'), '안녕하세요ai강의')
})

test('cer는 기준 대비 글자 편집 수', () => {
  assert.ok(Math.abs(cer('가나다라', '가나다마') - 0.25) < 1e-9)
  assert.equal(cer('가 나 다 라', '가나다라.'), 0)
  assert.equal(cer('', '가'), 1)
})

test('backendUsed는 whisper 로그를 읽는다', () => {
  assert.equal(backendUsed(['whisper_init_with_params_no_state: use gpu    = 1',
                            'whisper_backend_init_gpu: using Vulkan0 backend']), 'Vulkan0')
  assert.equal(backendUsed(['whisper_backend_init_gpu: no GPU found']), 'CPU')
})

test('textInRange는 구간 시작 시각으로 고른다', () => {
  const segments = [{ startMs: 0, endMs: 1, text: '앞' }, { startMs: 600000, endMs: 1, text: '안' }, { startMs: 1200000, endMs: 1, text: '뒤' }]
  assert.equal(textInRange(segments, 600000, 1200000), '안')
})
