import { useEffect, useRef, useState, type DragEvent } from 'react'
import { ApiError, call } from '../api'
import { Banner, Button, Card, Dialog, ProgressBar, StatusPill, useToast } from '../components'
import { cx } from '../components/cx'
import type { RecentNote } from '../../../core/recent'
import { mb, percent, useSetup, type LlmStatus } from '../wizard/shared'
import { ConfirmDialog } from './ConfirmDialog'
import { onRecordingFinished, useRecorder } from './recording'
import { RecordDialog, RecordingCard } from './Recorder'
import { aboutMinutes, isActive, lengthMinutes, STAGE_LABEL, waitingText, type JobView } from './shared'
import styles from './Home.module.css'
import { PC } from '../platform'

type Props = {
  jobs: JobView[] | null
  llm: LlmStatus | null
  onConnect: () => void
  onShowJobs: () => void
  /** 최근 노트를 누르면 앱 안에서 미리보기 */
  onPreview: (path: string) => void
  /** 바뀌면 최근 노트를 다시 읽는다 (노트 정보를 수정한 뒤) */
  refresh?: number
}

// 녹음 파형 모양 (끌어 놓기 칸 장식)
const WAVE = [10, 18, 26, 14, 22, 8, 16]

export function Home({ jobs, llm, onConnect, onShowJobs, onPreview, refresh }: Props): React.JSX.Element {
  const setup = useSetup()
  const toast = useToast()
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const [pending, setPending] = useState<string[] | null>(null)
  const [recent, setRecent] = useState<RecentNote[] | null>(null)
  const doneCount = jobs?.filter((j) => j.status === 'done').length ?? 0
  const rec = useRecorder()
  const [recordOpen, setRecordOpen] = useState(false)
  const [unprocessed, setUnprocessed] = useState<{ path: string; name: string }[]>([])
  const [confirmTrash, setConfirmTrash] = useState(false)

  // 노트가 새로 저장되면 최근 노트를 다시 읽는다
  useEffect(() => {
    call<RecentNote[]>('notes.recent').then(setRecent, () => setRecent([]))
  }, [doneCount, refresh])

  // 녹음을 끝내면 그 녹음으로 시작 전 확인을 연다
  useEffect(() => onRecordingFinished((path) => setPending([path])), [])

  // 아직 노트로 만들지 않은 앱 녹음: 시작 전 확인을 닫거나, 녹음이 끝나거나, 작업이 늘면 다시 본다
  const jobCount = jobs?.length ?? 0
  useEffect(() => {
    if (pending || rec.status !== 'idle') return
    call<{ path: string; name: string }[]>('rec.unprocessed').then(setUnprocessed, () => setUnprocessed([]))
  }, [pending, rec.status, jobCount])

  async function trashUnprocessed(): Promise<void> {
    setConfirmTrash(false)
    try {
      const n = await call<number>('rec.trash', unprocessed.map((r) => r.path))
      toast(`녹음 ${n}개를 휴지통으로 옮겼어요.`, 'success')
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '옮기지 못했어요.', 'danger')
    }
    setUnprocessed(await call<{ path: string; name: string }[]>('rec.unprocessed').catch(() => []))
  }

  function onDragEnter(e: DragEvent): void {
    if (!e.dataTransfer.types.includes('Files')) return
    depth.current++
    setOver(true)
  }
  function onDragLeave(): void {
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setOver(false)
  }
  function onDrop(e: DragEvent): void {
    e.preventDefault()
    depth.current = 0
    setOver(false)
    const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean)
    if (paths.length) setPending(paths)
  }

  async function pick(): Promise<void> {
    const paths = await call<string[]>('inputs.pick')
    if (paths.length) setPending(paths)
  }

  async function openFolder(): Promise<void> {
    try {
      await call('folder.openOut')
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '열지 못했어요.', 'danger')
    }
  }

  const model = setup?.model
  // 진행 중인 것만 처리 순서대로(도는 것이 맨 위). 목록은 최근 것부터 온다. 멈춘 작업은 작업 목록에서 다룬다.
  const shown = (jobs ?? []).filter(isActive).reverse()
  const stopped = (jobs ?? []).filter((j) => j.status === 'failed' || j.status === 'cancelled').length
  // 녹음을 시작하면 멈출 받아쓰기(오디오 준비 포함)가 돌고 있는가
  const transcribing = (jobs ?? []).some((j) => j.status === 'running' && (j.stage === 'audio' || j.stage === 'stt'))

  return (
    <div
      className={styles.home}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <RecordingCard />

      {/* 상황 배너: 한 번에 하나. 모델 → 속도 재기 → 처리하지 않은 녹음 → 멈춘 작업 → 요약 서비스 순 */}
      {model && (model.state === 'missing' || model.state === 'error') ? (
        <Banner
          tone="warning"
          title="받아쓰기 모델이 필요해요"
          action={
            <Button size="sm" variant="primary" onClick={() => void call('setup.download')}>
              {model.done > 0 ? '이어 받기' : '받기 시작'}
            </Button>
          }
        >
          {model.error ?? `${mb(model.total)} · 처음 한 번만 받아요.`}
        </Banner>
      ) : model?.state === 'downloading' ? (
        <Banner tone="info" title={`받아쓰기 모델 받는 중 ${percent(model.done, model.total)}%`}>
          녹음을 먼저 넣어도 돼요. 다 받으면 시작해요.
          <div className={styles.bannerBar}>
            <ProgressBar value={model.done / model.total} label="받아쓰기 모델 받기" />
          </div>
        </Banner>
      ) : model?.state === 'ready' && setup?.probe.state === 'running' ? (
        <Banner tone="info" title={`이 ${PC}의 받아쓰기 속도를 재는 중`}>
          1~2분 걸려요. 녹음을 먼저 넣어도 돼요. 다 재면 시작해요.
        </Banner>
      ) : unprocessed.length > 0 ? (
        <Banner
          tone="warning"
          title={unprocessed.length === 1 ? `노트로 만들지 않은 녹음 · ${unprocessed[0].name}` : `노트로 만들지 않은 녹음 ${unprocessed.length}개`}
          action={
            <>
              <Button size="sm" variant="ghost" onClick={() => setConfirmTrash(true)}>
                지우기
              </Button>
              <Button size="sm" variant="primary" onClick={() => setPending(unprocessed.map((r) => r.path))}>
                노트 만들기
              </Button>
            </>
          }
        >
          앱에서 한 녹음이 이 {PC}에 남아 있어요. 앱이 꺼져 끊긴 녹음도 끊기기 전까지 저장돼 있어요.
        </Banner>
      ) : stopped > 0 ? (
        <Banner
          tone="warning"
          title={`멈춘 작업 ${stopped}개`}
          action={
            <Button size="sm" onClick={onShowJobs}>
              작업 목록 보기
            </Button>
          }
        >
          이어서 다시 시도하거나 전사문만 저장할 수 있어요.
        </Banner>
      ) : (
        llm &&
        !llm.summary && (
          <Banner
            tone="info"
            title="요약 서비스를 연결하면"
            action={
              <Button size="sm" onClick={onConnect}>
                연결하기
              </Button>
            }
          >
            요약과 주요 키워드까지 만들어요. 지금은 전사문만 담겨요.
          </Banner>
        )
      )}

      <section className={cx(styles.drop, over && styles.over)} aria-label="녹음 넣기">
        <div className={styles.wave} aria-hidden="true">
          {WAVE.map((h, i) => (
            <i key={i} style={{ height: h }} />
          ))}
        </div>
        {over ? (
          <h2 className={styles.dropTitle}>놓으면 과목과 강의 언어를 정하는 창이 열려요</h2>
        ) : (
          <>
            <h2 className={styles.dropTitle}>녹음 파일을 여기에 끌어 놓으세요</h2>
            <p className={styles.types}>m4a · mp3 · wav · mp4 · webm 등</p>
            <div className={styles.buttons}>
              <Button onClick={() => void pick()}>파일 고르기</Button>
              <Button disabled={rec.status !== 'idle'} onClick={() => setRecordOpen(true)}>
                녹음하기
              </Button>
            </div>
            <p className={styles.hint}>같은 이름의 필기(.md·.txt)를 함께 넣으면 용어를 더 정확히 고쳐요</p>
          </>
        )}
      </section>

      {shown.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2>
              진행 중<span>{shown.length}</span>
            </h2>
            <Button variant="link" onClick={onShowJobs}>
              작업 목록 보기
            </Button>
          </div>
          <Card className={styles.jobs}>
            {shown.map((j) => (
              <JobRow key={j.id} job={j} />
            ))}
          </Card>
        </section>
      )}

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2>최근 노트</h2>
          {recent && recent.length > 0 && (
            <Button variant="link" onClick={() => void openFolder()}>
              저장 폴더 열기
            </Button>
          )}
        </div>
        {recent && recent.length === 0 && (
          <div className={styles.empty}>
            <b>첫 노트가 여기에 보여요</b>
            녹음을 넣으면 받아쓰기부터 요약, 저장 폴더에 노트 저장까지 알아서 해요.
          </div>
        )}
        {recent && recent.length > 0 && (
          <Card className={styles.notes}>
            {recent.map((n) => (
              <button key={n.path} className={styles.note} onClick={() => onPreview(n.path)}>
                <StatusPill>{n.subject ?? '미분류'}</StatusPill>
                <span className={styles.noteTitle}>{n.title}</span>
                <span className={styles.meta}>{n.date}</span>
              </button>
            ))}
          </Card>
        )}
      </section>

      {pending && <ConfirmDialog paths={pending} llm={llm} onClose={() => setPending(null)} />}
      <RecordDialog open={recordOpen} onClose={() => setRecordOpen(false)} transcribing={transcribing} />
      <Dialog
        open={confirmTrash}
        onClose={() => setConfirmTrash(false)}
        title={`녹음 ${unprocessed.length}개를 지울까요?`}
        actions={
          <>
            <Button onClick={() => setConfirmTrash(false)}>취소</Button>
            <Button variant="danger" onClick={() => void trashUnprocessed()}>
              휴지통으로 옮기기
            </Button>
          </>
        }
      >
        <p className={styles.dialogText}>노트로 만들지 않은 앱 녹음을 휴지통으로 옮겨요. 휴지통에서 되살릴 수 있어요.</p>
      </Dialog>
    </div>
  )
}

function JobRow({ job }: { job: JobView }): React.JSX.Element {
  const stage = job.stage ? STAGE_LABEL[job.stage] : null
  let right: React.JSX.Element
  let meta: string
  if (job.status === 'running' && job.stage) {
    right = <span className={styles.stage}>{job.stage === 'stt' ? `${stage} ${Math.floor(job.frac * 100)}%` : `${stage} 중`}</span>
    const parts = [job.durationS ? `${lengthMinutes(job.durationS)} 녹음` : null, job.etaS != null ? `${aboutMinutes(job.etaS)} 남음` : null]
    // 작업 중에 창을 닫으면 트레이로 숨어 계속한다
    meta = [...parts.filter(Boolean), '창을 닫아도 계속돼요'].join(' · ')
  } else {
    right = <StatusPill tone="waiting">대기</StatusPill>
    meta = waitingText(job.waiting)
  }
  return (
    <div className={styles.job}>
      <div className={styles.jobTop}>
        <StatusPill>{job.subject ?? '미분류'}</StatusPill>
        <span className={styles.jobName}>{job.name}</span>
        {right}
      </div>
      {job.status === 'running' && job.stage === 'stt' && <ProgressBar value={job.frac} label={`${job.name} 받아쓰기`} />}
      {meta && <p className={styles.meta}>{meta}</p>}
    </div>
  )
}
