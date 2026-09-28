import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fitContent } from '../src/main/fit.ts'

const MIN = { width: 800, height: 600 }
const HOME = { width: 1000, height: 750 }
const FRAME = { width: 16, height: 65 } // 125% 배율 데스크톱의 제목 표시줄 + 메뉴 줄 + 테두리

test('작업 영역이 넉넉하면 목표 크기 그대로', () => {
  assert.deepEqual(fitContent(HOME, { width: 2752, height: 1152 }, FRAME, 4 / 3, MIN), HOME)
})

test('150% 배율 1920x1080 노트북(작업 영역 약 1280x680)에서는 들어가는 가장 큰 4:3', () => {
  const size = fitContent(HOME, { width: 1280, height: 680 }, FRAME, 4 / 3, MIN)
  assert.deepEqual(size, { width: 820, height: 615 })
  assert.ok(size.height + FRAME.height <= 680)
})

test('작업 영역이 최소 크기보다 작으면 최소 크기 (창이 넘칠 수 있음)', () => {
  assert.deepEqual(fitContent(HOME, { width: 1024, height: 600 }, FRAME, 4 / 3, MIN), MIN)
})
