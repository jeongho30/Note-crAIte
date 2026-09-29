import { useCallback, useEffect, useRef, useState } from 'react'
import { call } from '../api'
import { useToast } from '../components'
import { cx } from '../components/cx'
import { Settings } from '../settings/Settings'
import type { LlmStatus } from '../wizard/shared'
import { Home } from './Home'
import { JobList } from './JobList'
import { isActive, useJobs } from './shared'
import styles from './Shell.module.css'

type View = 'home' | 'jobs' | 'settings'

const NAV: { view: View; label: string }[] = [
  { view: 'home', label: '홈' },
  { view: 'jobs', label: '작업 목록' },
  { view: 'settings', label: '설정' }
]

type Props = {
  /** 설정 > 정보의 [첫 실행 마법사 다시 보기] */
  onRestartWizard: () => void
}

// 앱 틀: 왼쪽 사이드바(메뉴, 남은 크레딧)와 오른쪽 본문.
export default function Shell({ onRestartWizard }: Props): React.JSX.Element {
  const [view, setView] = useState<View>('home')
  const [openKey, setOpenKey] = useState(0)
  const [llm, setLlm] = useState<LlmStatus | null>(null)
  const jobs = useJobs()
  const toast = useToast()
  const seen = useRef<Map<string, string> | null>(null)
  const doneCount = jobs?.filter((j) => j.status === 'done').length ?? 0

  const loadLlm = useCallback(() => {
    call<LlmStatus>('llm.status').then(setLlm, () => setLlm({ provider: null }))
  }, [])

  // 요약이 끝나면 크레딧이 바뀌므로, 끝난 작업 수가 바뀔 때마다 다시 불러온다
  useEffect(loadLlm, [doneCount, loadLlm])

  // 홈의 [연결하기]·작업 목록의 [키 다시 넣기]: 설정의 요약 서비스에서 키 입력칸을 연다
  const onConnect = (): void => {
    setView('settings')
    setOpenKey((n) => n + 1)
  }

  // 작업이 끝나거나 실패하면 알린다 (처음 불러온 목록은 알리지 않는다)
  useEffect(() => {
    if (!jobs) return
    const prev = seen.current
    seen.current = new Map(jobs.map((j) => [j.id, j.status]))
    if (!prev) return
    for (const j of jobs) {
      const before = prev.get(j.id)
      if (before === j.status || (before !== 'running' && before !== 'queued')) continue
      if (j.status === 'done') toast(`노트가 만들어졌어요 · ${j.subject ?? '미분류'}`, 'success')
      // 요청 몰림으로 1분 뒤 저절로 다시 시도하는 것은 알리지 않는다 (그래도 안 되면 그때 알린다)
      if (j.status === 'failed' && !j.autoRetryAt) toast(`${j.name} · ${j.error?.message ?? '노트를 만들지 못했어요.'}`, 'danger')
    }
  }, [jobs, toast])

  const active = jobs?.filter(isActive).length ?? 0

  return (
    <div className={styles.shell}>
      <nav className={styles.side} aria-label="메뉴">
        {NAV.map((n) => (
          <button
            key={n.view}
            className={cx(styles.nav, view === n.view && styles.on)}
            aria-current={view === n.view ? 'page' : undefined}
            onClick={() => setView(n.view)}
          >
            {n.label}
            {n.view === 'jobs' && active > 0 && <span className={styles.count}>{active}</span>}
          </button>
        ))}
        <div className={styles.foot}>
          {llm?.provider && llm.credits != null && (
            <>
              <span>남은 크레딧</span>
              <b>{llm.credits.toLocaleString()}</b>
              {llm.summariesLeft != null && <span>이번 달 약 {llm.summariesLeft.toLocaleString()}개 더 요약 가능</span>}
            </>
          )}
          {llm?.provider && llm.credits == null && <b>{llm.name}와 연동됨</b>}
          {llm && !llm.provider && (
            <>
              <b>요약 서비스 없음</b>
              <span>전사문만 담은 노트를 만들어요</span>
            </>
          )}
        </div>
      </nav>
      <main className={styles.main}>
        {view === 'home' && <Home jobs={jobs} llm={llm} onConnect={onConnect} onShowJobs={() => setView('jobs')} />}
        {view === 'jobs' && <JobList jobs={jobs} onConnect={onConnect} onHome={() => setView('home')} />}
        {view === 'settings' && (
          <Settings llm={llm} doneCount={doneCount} openKey={openKey} onLlmChange={loadLlm} onRestartWizard={onRestartWizard} />
        )}
      </main>
    </div>
  )
}
