import { useEffect, useState, type RefObject } from 'react'
import { call } from '../api'
import type { SetupState } from '../../../main/setup'

export type StepProps = {
  next: () => void
  back: () => void
  goTo: (step: number) => void
  headingRef: RefObject<HTMLHeadingElement | null>
}

export type LlmStatus = { provider: string | null; name?: string; keyHint?: string; credits?: number | null; summariesLeft?: number | null }

/** 모델 받기·속도 재기 상태. 메인이 바뀔 때마다 보내 준다. */
export function useSetup(): SetupState | null {
  const [state, setState] = useState<SetupState | null>(null)
  useEffect(() => {
    let alive = true
    const off = window.api.on('setup', (d) => setState(d as SetupState))
    call<SetupState>('setup.get').then((d) => alive && setState((prev) => prev ?? d))
    return () => {
      alive = false
      off()
    }
  }, [])
  return state
}

export const mb = (bytes: number): string => `${Math.round(bytes / 1e6).toLocaleString()}MB`
export const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)}GB`
export const percent = (done: number, total: number): number => (total ? Math.floor((done / total) * 100) : 0)

/** "AMD Radeon RX 9070 XT (AMD proprietary driver)" → "AMD Radeon RX 9070 XT" */
export const gpuLabel = (name: string): string => name.replace(/\s*\([^)]*\)\s*$/, '')

/** 받아쓰기 준비 상태 한 줄 (이 PC 확인·준비 완료 화면 공용) */
export function sttSummary(s: SetupState): string {
  const { model, probe } = s
  if (model.state === 'downloading') return `모델 받는 중 ${percent(model.done, model.total)}% · 먼저 넣은 녹음은 다 받은 뒤 시작해요`
  if (model.state !== 'ready') return '모델을 아직 받지 않았어요'
  if (probe.state === 'done') {
    const where = probe.gpuName ? `그래픽카드(${gpuLabel(probe.gpuName)})` : '이 PC의 프로세서'
    return `${where} · 90분 강의 약 ${probe.minutesFor90}분`
  }
  if (probe.state === 'error') return '속도를 재지 못했어요 · 프로세서로 받아써요'
  return '이 PC의 받아쓰기 속도를 재는 중이에요'
}
