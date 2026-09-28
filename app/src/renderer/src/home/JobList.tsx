import { useEffect, useState, type MouseEvent } from 'react'
import { ApiError, call } from '../api'
import { Button, Card, ProgressBar, StatusPill, useToast } from '../components'
import { cx } from '../components/cx'
import type { StageName } from '../../../core/job'
import {
  aboutMinutes,
  elapsed,
  isActive,
  lengthMinutes,
  localDate,
  localDateTime,
  noteTitle,
  STAGE_LABEL,
  type JobView
} from './shared'
import styles from './JobList.module.css'

type Props = {
  jobs: JobView[] | null
  /** 키 오류일 때 [키 다시 넣기] (설정 화면이 생기기 전까지는 마법사의 요약 서비스 단계) */
  onConnect: () => void
  onHome: () => void
}

const DONE_PAGE = 20

// 1초마다 다시 그린다 (요청 몰림 자동 재시도까지 남은 시간)
function useTick(on: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

// 작업 목록: 진행 중(처리 순서) · 멈춘 작업 · 완료(최근 것부터). 줄을 누르면 단계별 진행과 녹음 정보가 펼쳐진다.
export function JobList({ jobs, onConnect, onHome }: Props): React.JSX.Element | null {
  const [open, setOpen] = useState<string | null>(null)
  const [doneShown, setDoneShown] = useState(DONE_PAGE)
  const toast = useToast()
  const now = useTick(!!jobs?.some((j) => j.autoRetryAt))
  if (!jobs) return null

  async function act(method: string, id: string): Promise<void> {
    try {
      await call(method, id)
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '하지 못했어요. 다시 시도해 주세요.', 'danger')
    }
  }

  const active = jobs.filter(isActive).reverse()
  const stopped = jobs.filter((j) => j.status === 'failed' || j.status === 'cancelled')
  const done = jobs.filter((j) => j.status === 'done')
  const row = (j: JobView): React.JSX.Element => (
    <JobRow key={j.id} job={j} now={now} open={open === j.id} onToggle={() => setOpen(open === j.id ? null : j.id)} act={act} onConnect={onConnect} />
  )

  return (
    <div className={styles.list}>
      <div className={styles.head}>
        <h1>작업 목록</h1>
        {jobs.length > 0 && <span>{jobs.length}개</span>}
      </div>

      {jobs.length === 0 && (
        <div className={styles.empty}>
          <b>아직 작업이 없어요</b>
          홈에서 녹음을 넣으면 여기에 쌓여요.
          <div>
            <Button size="sm" onClick={onHome}>
              홈으로
            </Button>
          </div>
        </div>
      )}

      {active.length > 0 && (
        <section className={styles.group}>
          <h2>
            진행 중<span>{active.length}</span>
          </h2>
          <Card className={styles.card}>{active.map(row)}</Card>
        </section>
      )}
      {stopped.length > 0 && (
        <section className={styles.group}>
          <h2>
            멈춘 작업<span>{stopped.length}</span>
          </h2>
          <Card className={styles.card}>{stopped.map(row)}</Card>
        </section>
      )}
      {done.length > 0 && (
        <section className={styles.group}>
          <h2>
            완료<span>{done.length}</span>
          </h2>
          <Card className={styles.card}>{done.slice(0, doneShown).map(row)}</Card>
          {done.length > doneShown && (
            <div className={styles.more}>
              <Button size="sm" variant="ghost" onClick={() => setDoneShown((n) => n + DONE_PAGE)}>
                더 보기 ({done.length - doneShown}개)
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

type RowProps = {
  job: JobView
  now: number
  open: boolean
  onToggle: () => void
  act: (method: string, id: string) => Promise<void>
  onConnect: () => void
}

const stop = (e: MouseEvent): void => e.stopPropagation()

function JobRow({ job: j, now, open, onToggle, act, onConnect }: RowProps): React.JSX.Element {
  const failed = j.status === 'failed'
  const sttDone = j.stages.find((s) => s.name === 'stt')?.status === 'done'
  const stageLabel = (s: StageName): string => STAGE_LABEL[s]
  const summarySkipped = j.stages.find((s) => s.name === 'summarize')?.status === 'skipped'
  const waitingRetry = failed && j.autoRetryAt !== null

  let status: React.JSX.Element
  let meta = ''
  const actions: React.JSX.Element[] = []
  const button = (label: string, onClick: () => void, variant: 'secondary' | 'ghost' = 'secondary'): React.JSX.Element => (
    <Button key={label} size="sm" variant={variant} onClick={onClick}>
      {label}
    </Button>
  )

  if (j.status === 'running' && j.stage) {
    status = <span className={styles.stage}>{j.stage === 'stt' ? `${stageLabel('stt')} ${Math.floor(j.frac * 100)}%` : `${stageLabel(j.stage)} 중`}</span>
    meta = [j.durationS ? `${lengthMinutes(j.durationS)} 녹음` : null, j.etaS != null ? `${aboutMinutes(j.etaS)} 남음` : null, '창을 닫아도 계속돼요']
      .filter(Boolean)
      .join(' · ')
    actions.push(button('취소', () => void act('jobs.cancel', j.id), 'ghost'))
  } else if (isActive(j)) {
    status = <StatusPill tone="waiting">대기</StatusPill>
    meta = j.waiting === 'model' ? '받아쓰기 모델을 다 받으면 시작해요' : '앞의 작업이 끝나면 시작해요'
    actions.push(button('취소', () => void act('jobs.cancel', j.id), 'ghost'))
  } else if (waitingRetry) {
    const left = Math.max(0, Math.ceil((j.autoRetryAt! - now) / 1000))
    status = <StatusPill tone="warning">{j.error ? `${stageLabel(j.error.stage)} 대기` : '대기'}</StatusPill>
    meta = `요청이 몰려 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 뒤 저절로 다시 시도해요`
  } else if (failed) {
    const at = j.error ? stageLabel(j.error.stage) : null
    status = <StatusPill tone="danger">{at ? `${at} 실패` : '실패'}</StatusPill>
    const afterStt = sttDone && j.error && j.error.stage !== 'audio' && j.error.stage !== 'stt'
    meta = (j.error?.message.split('\n')[0] ?? '') + (afterStt ? ' 받아쓰기는 끝나 있어서 다시 하지 않아요.' : '')
    const code = j.error?.code
    if (code === 'auth') actions.push(button('키 다시 넣기', onConnect))
    if ((code === 'credits' || code === 'too_large') && sttDone) actions.push(button('전사만 저장', () => void act('jobs.transcriptOnly', j.id)))
    if (code !== 'too_large') actions.push(button('이어서 다시 시도', () => void act('jobs.retry', j.id)))
  } else if (j.status === 'cancelled') {
    status = <StatusPill tone="waiting">취소됨</StatusPill>
    meta = j.sttChunks ? `받아쓰기 ${j.sttChunks.total}조각 중 ${j.sttChunks.done}조각까지 했어요` : '취소했어요'
    actions.push(button('이어서 다시 시도', () => void act('jobs.retry', j.id)))
  } else {
    status = <StatusPill tone="success">완료</StatusPill>
    meta = [
      j.recordedAt ? localDate(j.recordedAt) : null,
      j.durationS ? lengthMinutes(j.durationS) : null,
      j.language === 'en' ? '영어 강의' : null,
      summarySkipped ? '요약 없음' : j.credits != null ? `${j.credits}크레딧` : null
    ]
      .filter(Boolean)
      .join(' · ')
    actions.push(button('노트 열기', () => void act('jobs.openNote', j.id)))
    actions.push(button('폴더에서 보기', () => void act('jobs.revealNote', j.id), 'ghost'))
  }

  const title = j.status === 'done' && j.notePath ? noteTitle(j.notePath) : j.name

  return (
    <div className={cx(styles.row, open && styles.open)}>
      <div className={styles.top} onClick={onToggle}>
        <button className={styles.chev} aria-expanded={open} aria-label={`${title} 자세히`} onClick={(e) => (stop(e), onToggle())} />
        <StatusPill>{j.subject ?? '미분류'}</StatusPill>
        <span className={styles.name}>
          {title}
          {j.status === 'done' && summarySkipped && <small>전사만</small>}
        </span>
        {status}
        {actions.length > 0 && (
          <span className={styles.actions} onClick={stop}>
            {actions}
          </span>
        )}
      </div>
      {j.status === 'running' && j.stage === 'stt' && (
        <div className={styles.indent}>
          <ProgressBar value={j.frac} label={`${j.name} 받아쓰기`} />
        </div>
      )}
      {meta && <p className={styles.meta}>{meta}</p>}
      {open && <Detail job={j} act={act} />}
    </div>
  )
}

// 펼친 칸: 단계 목록과 녹음 정보. 멈춘 작업·취소한 작업만 오른쪽 아래에 [목록에서 지우기].
function Detail({ job: j, act }: { job: JobView; act: RowProps['act'] }): React.JSX.Element {
  // 노트 만들기·노트 저장은 한 줄로 보여 준다
  const byName = Object.fromEntries(j.stages.map((s) => [s.name, s]))
  const merged = [
    ...(['audio', 'stt', 'clean', 'summarize'] as StageName[]).map((n) => ({ ...byName[n], label: STAGE_LABEL[n] })),
    {
      name: 'save' as StageName,
      label: STAGE_LABEL.save,
      status: byName.note.status === 'failed' || byName.note.status === 'running' ? byName.note.status : byName.save.status,
      ms: byName.note.ms !== null && byName.save.ms !== null ? byName.note.ms + byName.save.ms : null
    }
  ]
  const removable = j.status === 'failed' || j.status === 'cancelled'

  return (
    <div className={styles.detail}>
      <ul className={styles.stages}>
        {merged.map((s) => {
          const failedHere = s.status === 'failed' || (j.error && j.error.stage === s.name && s.status !== 'done')
          const cls = s.status === 'done' ? styles.done : failedHere ? styles.fail : s.status === 'skipped' ? styles.skip : s.status === 'running' ? styles.run : styles.todo
          const text =
            s.status === 'skipped' ? `${s.label} · 건너뜀` : failedHere && j.error ? `${s.label} · ${j.error.code === 'cancelled' ? '취소함' : j.error.message.split('\n')[0]}` : s.label
          return (
            <li key={s.name} className={cls}>
              <span className={styles.dot} aria-hidden="true">
                {s.status === 'done' ? '✓' : failedHere ? '!' : ''}
              </span>
              <span className={styles.stageText}>{text}</span>
              <span className={styles.time}>{s.status === 'done' && s.ms !== null ? elapsed(s.ms) : ''}</span>
            </li>
          )
        })}
      </ul>
      <dl className={styles.info}>
        {j.notePath && (
          <>
            <dt>노트</dt>
            <dd>{j.notePath}</dd>
          </>
        )}
        <dt>녹음</dt>
        <dd>{j.audioPath}</dd>
        <dt>필기</dt>
        <dd>{j.hasNotes ? '있음 (함께 넣음)' : '없음'}</dd>
        <dt>강의 언어</dt>
        <dd>{j.language === 'en' ? '영어' : '한국어'}</dd>
        <dt>넣은 시각</dt>
        <dd>{localDateTime(j.createdAt)}</dd>
      </dl>
      {removable && (
        <div className={styles.foot}>
          <span>작업 파일만 지워요. 녹음과 노트는 그대로예요.</span>
          <Button size="sm" variant="outline" onClick={() => void act('jobs.remove', j.id)}>
            목록에서 지우기
          </Button>
        </div>
      )}
    </div>
  )
}
