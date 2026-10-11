import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_MODEL, LIGHT_MODEL } from '../src/core/job.ts'
import { afterProbe, firstModel } from '../src/core/recommend.ts'

test('firstModel: 외장 그래픽카드나 Mac이면 기본 모델, 아니면 가벼운 모델로 먼저 잰다', () => {
  assert.equal(firstModel({ gpus: ['AMD Radeon RX 9070 XT', 'AMD Radeon(TM) Graphics'] }, 'win32'), DEFAULT_MODEL)
  assert.equal(firstModel({ gpus: ['Intel(R) UHD Graphics', 'NVIDIA GeForce RTX 3070 Laptop GPU'] }, 'win32'), DEFAULT_MODEL)
  assert.equal(firstModel({ gpus: ['Intel(R) Arc(TM) A770 Graphics'] }, 'win32'), DEFAULT_MODEL)
  assert.equal(firstModel({ gpus: ['AMD Radeon(TM) Graphics'] }, 'win32'), LIGHT_MODEL)
  assert.equal(firstModel({ gpus: ['Intel(R) Iris(R) Xe Graphics'] }, 'win32'), LIGHT_MODEL)
  assert.equal(firstModel({ gpus: ['Intel(R) Arc(TM) Graphics'] }, 'win32'), LIGHT_MODEL)
  assert.equal(firstModel({ gpus: [] }, 'win32'), LIGHT_MODEL)
  assert.equal(firstModel({ gpus: [] }, 'darwin'), DEFAULT_MODEL)
})

test('afterProbe: 가벼운 모델로 잰 값으로 기본 모델을 받을지 정한다', () => {
  // 그래픽카드로 돌면 기본 모델
  assert.deepEqual(afterProbe(LIGHT_MODEL, 2, true), { model: DEFAULT_MODEL, settled: false })
  // 가벼운 모델 9분이면 기본 모델 약 29분: 기준(30분) 안
  assert.deepEqual(afterProbe(LIGHT_MODEL, 9, false), { model: DEFAULT_MODEL, settled: false })
  // 노트북(5700U) 가벼운 모델 약 12분이면 기본 모델 약 38분: 가벼운 모델로 둔다
  assert.deepEqual(afterProbe(LIGHT_MODEL, 12, false), { model: LIGHT_MODEL, settled: true })
})

test('afterProbe: 기본 모델이 30분을 넘으면 가벼운 모델로 내리고, 그 뒤로는 바꾸지 않는다', () => {
  assert.deepEqual(afterProbe(DEFAULT_MODEL, 30, false), { model: DEFAULT_MODEL, settled: true })
  assert.deepEqual(afterProbe(DEFAULT_MODEL, 33, false), { model: LIGHT_MODEL, settled: true })
  assert.deepEqual(afterProbe(DEFAULT_MODEL, 1, true), { model: DEFAULT_MODEL, settled: true })
})
