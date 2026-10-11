// 이 PC에 맞는 받아쓰기 모델 고르기 (10/11): 기본(turbo)이 90분 강의에 TURBO_LIMIT_MIN분을 넘으면 가볍게(small)를 쓴다.
// 그래픽카드가 없는 PC는 기본 모델(874MB)을 받기 전에 가벼운 모델(190MB)로 먼저 속도를 재서 기본 모델의 시간을 어림한다.
import type { Hardware } from './hardware.ts'
import { DEFAULT_MODEL, LIGHT_MODEL } from './job.ts'

/** 기본 모델로 90분 강의를 받아쓰는 데 이보다 오래 걸리면 가벼운 모델을 쓴다 (분) */
export const TURBO_LIMIT_MIN = 30
// CPU에서 기본 모델 시간 ÷ 가벼운 모델 시간. 실측: 노트북 82분 강의 2.8(29분 42초 ÷ 10분 28초), 데스크톱 39초 샘플 3.6
const TURBO_PER_LIGHT = 3.2

// 외장 그래픽카드 이름. 내장("AMD Radeon(TM) Graphics", "Intel(R) Iris(R) Xe Graphics")은 걸리지 않게 한다
const DISCRETE_GPU_RE = /nvidia|geforce|quadro|radeon (rx|pro)|\barc\S* [ab]\d/i

/** 아무 모델도 받기 전에 처음 받을 모델. 외장 그래픽카드가 있거나 Mac이면 기본, 아니면 가벼운 모델로 먼저 잰다 */
export function firstModel(hw: Pick<Hardware, 'gpus'>, platform: string): string {
  return platform === 'darwin' || hw.gpus.some((g) => DISCRETE_GPU_RE.test(g)) ? DEFAULT_MODEL : LIGHT_MODEL
}

/**
 * 속도를 잰 뒤 쓸 모델. settled면 더 바꾸지 않는다.
 * 가벼운 모델로 쟀을 때: 그래픽카드로 돌았거나 기본 모델의 어림이 기준 안이면 기본 모델로 올린다 (올린 뒤 실제로 재서 한 번 더 본다).
 * 기본 모델로 쟀을 때: 기준을 넘으면 가벼운 모델로 내린다.
 */
export function afterProbe(model: string, minutesFor90: number, gpu: boolean): { model: string; settled: boolean } {
  if (model === LIGHT_MODEL) {
    return gpu || minutesFor90 * TURBO_PER_LIGHT <= TURBO_LIMIT_MIN ? { model: DEFAULT_MODEL, settled: false } : { model, settled: true }
  }
  if (model === DEFAULT_MODEL && minutesFor90 > TURBO_LIMIT_MIN) return { model: LIGHT_MODEL, settled: true }
  return { model, settled: true }
}
