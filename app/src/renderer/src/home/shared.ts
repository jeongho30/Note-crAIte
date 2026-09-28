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
  summarize: '요약',
  note: '노트 만들기',
  save: '노트 저장'
}

export const isActive = (j: JobView): boolean => j.status === 'running' || j.status === 'queued'

/** "약 23분", 1분이 안 되면 "1분 안쪽" */
export function aboutMinutes(seconds: number): string {
  return seconds < 60 ? '1분 안쪽' : `약 ${Math.round(seconds / 60)}분`
}

/** 녹음 길이 "63분" */
export function lengthMinutes(seconds: number): string {
  return `${Math.max(1, Math.round(seconds / 60))}분`
}
