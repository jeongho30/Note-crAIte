import { useEffect, useState } from 'react'
import { call } from '../api'
import type { JobView } from '../../../main/jobs'
import type { StageName } from '../../../core/job'

export type { JobView }

/** 작업 목록. 메인이 바뀔 때마다 보내 준다. */
export function useJobs(): JobView[] | null {
  const [jobs, setJobs] = useState<JobView[] | null>(null)
  useEffect(() => {
    let alive = true
    const off = window.api.on('jobs', (d) => setJobs(d as JobView[]))
    call<JobView[]>('jobs.list').then((d) => alive && setJobs((prev) => prev ?? d))
    return () => {
      alive = false
      off()
    }
  }, [])
  return jobs
}

export const STAGE_LABEL: Record<StageName, string> = {
  audio: '오디오 준비',
  stt: '받아쓰기',
  clean: '정리',
  polish: '전사문 다듬기',
  summarize: '요약',
  note: '노트 만들기',
  save: '노트 저장'
}

export const isActive = (j: JobView): boolean => j.status === 'running' || j.status === 'queued'

/** 대기 중인 작업이 무엇을 기다리는지 */
export function waitingText(waiting: JobView['waiting']): string {
  if (waiting === 'model') return '받아쓰기 모델을 다 받으면 시작해요'
  if (waiting === 'recording') return '녹음이 끝나면 이어서 해요'
  return '앞의 작업이 끝나면 시작해요'
}

/** "약 23분", 1분이 안 되면 "1분 안쪽" */
export function aboutMinutes(seconds: number): string {
  return seconds < 60 ? '1분 안쪽' : `약 ${Math.round(seconds / 60)}분`
}

/** 녹음 길이 "63분" */
export function lengthMinutes(seconds: number): string {
  return `${Math.max(1, Math.round(seconds / 60))}분`
}

/** 단계에 걸린 시간 "27분 12초", "8초", "1초 안쪽" */
export function elapsed(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 1) return '1초 안쪽'
  if (s < 60) return `${s}초`
  return `${Math.floor(s / 60)}분${s % 60 ? ` ${s % 60}초` : ''}`
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** "2026-09-26" */
export function localDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "2026-09-26 15:02" */
export function localDateTime(iso: string): string {
  const d = new Date(iso)
  return `${localDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 노트 파일 이름 "2026-09-21 Lexical Analysis.md" → "Lexical Analysis" */
export function noteTitle(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path
  return name.replace(/\.md$/i, '').replace(/^\d{4}-\d{2}-\d{2} /, '')
}
