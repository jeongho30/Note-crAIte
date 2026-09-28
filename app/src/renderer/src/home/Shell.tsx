import { useEffect, useRef, useState } from 'react'
import { call } from '../api'
import { useToast } from '../components'
import { cx } from '../components/cx'
import type { LlmStatus } from '../wizard/shared'
import { Home } from './Home'
import { isActive, useJobs } from './shared'
import styles from './Shell.module.css'

type View = 'home' | 'jobs' | 'settings'

const NAV: { view: View; label: string }[] = [
  { view: 'home', label: '홈' },
  { view: 'jobs', label: '작업 목록' },
  { view: 'settings', label: '설정' }
]

type Props = {
  /** 설정 화면이 생기기 전까지, 요약 서비스 연결은 마법사의 그 단계를 다시 연다 */
  onConnect: () => void
}

// 앱 틀: 왼쪽 사이드바(메뉴, 남은 크레딧)와 오른쪽 본문.
export default function Shell({ onConnect }: Props): React.JSX.Element {
  const [view, setView] = useState<View>('home')
  const [llm, setLlm] = useState<LlmStatus | null>(null)
  const jobs = useJobs()
  const toast = useToast()
  const seen = useRef<Map<string, string> | null>(null)
  const doneCount = jobs?.filter((j) => j.status === 'done').length ?? 0

  // 요약이 끝나면 크레딧이 바뀌므로, 끝난 작업 수가 바뀔 때마다 다시 불러온다
  useEffect(() => {
    call<LlmStatus>('llm.status').then(setLlm, () => setLlm({ provider: null }))
  }, [doneCount])

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
      if (j.status === 'failed') toast(`${j.name} · ${j.error?.message ?? '노트를 만들지 못했어요.'}`, 'danger')
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
        {view === 'home' && <Home jobs={jobs} llm={llm} onConnect={onConnect} />}
        {view !== 'home' && (
          <div className={styles.placeholder}>
            <h1>{NAV.find((n) => n.view === view)!.label}</h1>
            <p>다음 작업에서 만들어요.</p>
          </div>
        )}
      </main>
    </div>
  )
}
