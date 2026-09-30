import { useCallback, useEffect, useRef, useState } from 'react'
import { call } from '../api'
import { useToast } from '../components'
import { cx } from '../components/cx'
import { NoteList } from '../notes/NoteList'
import { NotePreview } from '../preview/NotePreview'
import { Settings } from '../settings/Settings'
import type { LlmStatus } from '../wizard/shared'
import { Home } from './Home'
import { JobList } from './JobList'
import { useRecorder } from './recording'
import { isActive, useJobs } from './shared'
import styles from './Shell.module.css'

type View = 'home' | 'jobs' | 'notes' | 'settings'

const NAV: { view: View; label: string }[] = [
  { view: 'home', label: '홈' },
  { view: 'jobs', label: '작업 목록' },
  { view: 'notes', label: '노트 목록' },
  { view: 'settings', label: '설정' }
]

type Props = {
  /** 설정 > 정보의 [첫 실행 마법사 다시 보기] */
  onRestartWizard: () => void
}

// 앱 틀: 왼쪽 사이드바(메뉴, 남은 크레딧)와 오른쪽 본문.
export default function Shell({ onRestartWizard }: Props): React.JSX.Element {
  const [view, setView] = useState<View>('home')
  // 노트 미리보기는 지금 화면을 숨겨 둔 채 열고, [돌아가기]로 그 화면에 돌아간다 (검색어·펼친 줄이 그대로)
  const [preview, setPreviewPath] = useState<string | null>(null)
  const [openKey, setOpenKey] = useState(0)
  const mainRef = useRef<HTMLElement>(null)
  const savedScroll = useRef(0)
  // 미리보기는 맨 위부터 보이고, 닫으면 앞 화면의 스크롤 위치로 돌아간다
  const setPreview = useCallback((path: string | null) => {
    const main = mainRef.current
    setPreviewPath((open) => {
      if (main && !open && path) savedScroll.current = main.scrollTop
      return path
    })
  }, [])
  useEffect(() => {
    mainRef.current?.scrollTo(0, preview ? 0 : savedScroll.current)
  }, [preview])
  const [llm, setLlm] = useState<LlmStatus | null>(null)
  const jobs = useJobs()
  const toast = useToast()
  const seen = useRef<Map<string, string> | null>(null)
  const doneCount = jobs?.filter((j) => j.status === 'done').length ?? 0
  const [notesVersion, setNotesVersion] = useState(0) // 미리보기에서 노트 정보를 수정하면 앞 화면의 노트 목록을 다시 읽는다

  const loadLlm = useCallback(() => {
    call<LlmStatus>('llm.status').then(setLlm, () => setLlm({ provider: null }))
  }, [])

  // 요약이 끝나면 크레딧이 바뀌므로, 끝난 작업 수가 바뀔 때마다 다시 불러온다
  useEffect(loadLlm, [doneCount, loadLlm])

  // 홈의 [연결하기]·작업 목록의 [키 다시 넣기]: 설정의 요약 서비스에서 키 입력칸을 연다
  const onConnect = (): void => {
    setPreview(null)
    setView('settings')
    setOpenKey((n) => n + 1)
  }

  const go = (v: View): void => {
    setPreview(null)
    setView(v)
  }

  // 트레이 알림을 누르면 메인이 화면을 옮겨 달라고 한다 (완료는 미리보기, 실패는 작업 목록)
  useEffect(
    () =>
      window.api.on('navigate', (d) => {
        const to = d as { view: View } | { view: 'preview'; path: string }
        if (to.view === 'preview') setPreview(to.path)
        else go(to.view)
      }),
    []
  )

  // 작업이 끝나거나 실패하면 알린다 (처음 불러온 목록은 알리지 않는다)
  useEffect(() => {
    if (!jobs) return
    const prev = seen.current
    seen.current = new Map(jobs.map((j) => [j.id, j.status]))
    if (!prev) return
    for (const j of jobs) {
      const before = prev.get(j.id)
      if (before === j.status || (before !== 'running' && before !== 'queued')) continue
      const note = j.notePath
      if (j.status === 'done') {
        toast(`노트가 만들어졌어요 · ${j.subject ?? '미분류'}`, 'success', note ? { label: '보기', onClick: () => setPreview(note) } : undefined)
      }
      // 요청 몰림으로 1분 뒤 저절로 다시 시도하는 것은 알리지 않는다 (그래도 안 되면 그때 알린다)
      if (j.status === 'failed' && !j.autoRetryAt) toast(`${j.name} · ${j.error?.message ?? '노트를 만들지 못했어요.'}`, 'danger')
    }
  }, [jobs, toast])

  const active = jobs?.filter(isActive).length ?? 0
  // 다른 화면에 있어도 녹음 중인 것이 보이게 (끝내기는 홈에서)
  const rec = useRecorder()
  const recording = rec.status === 'recording' || rec.status === 'paused' || rec.status === 'stopping'

  return (
    <div className={styles.shell}>
      <nav className={styles.side} aria-label="메뉴">
        {NAV.map((n) => (
          <button
            key={n.view}
            className={cx(styles.nav, view === n.view && styles.on)}
            aria-current={view === n.view ? 'page' : undefined}
            onClick={() => go(n.view)}
          >
            {n.label}
            {n.view === 'jobs' && active > 0 && <span className={styles.count}>{active}</span>}
            {n.view === 'home' && recording && <span className={styles.rec}>녹음 중</span>}
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
      <main className={styles.main} ref={mainRef}>
        {preview && <NotePreview path={preview} jobs={jobs} llm={llm} onBack={() => setPreview(null)} onConnect={onConnect} onMoved={(next) => { setPreview(next); setNotesVersion((v) => v + 1) }} onDeleted={() => { setPreview(null); setNotesVersion((v) => v + 1) }} />}
        <div hidden={!!preview}>
          {view === 'home' && <Home refresh={notesVersion} jobs={jobs} llm={llm} onConnect={onConnect} onShowJobs={() => setView('jobs')} onPreview={setPreview} />}
          {view === 'jobs' && <JobList jobs={jobs} onConnect={onConnect} onSettings={() => go('settings')} onHome={() => setView('home')} onPreview={setPreview} />}
          {view === 'notes' && <NoteList refresh={notesVersion} doneCount={doneCount} onPreview={setPreview} />}
          {view === 'settings' && (
            <Settings llm={llm} doneCount={doneCount} openKey={openKey} onLlmChange={loadLlm} onRestartWizard={onRestartWizard} />
          )}
        </div>
      </main>
    </div>
  )
}
