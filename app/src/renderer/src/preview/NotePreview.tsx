import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { ApiError, call } from '../api'
import { Banner, Button, Dialog, MoreMenu, useToast } from '../components'
import { isActive, lengthMinutes, STAGE_LABEL, type JobView } from '../home/shared'
import type { LlmStatus } from '../wizard/shared'
import 'katex/dist/katex.min.css'
import { NoteDeleteDialog } from '../notes/NoteDeleteDialog'
import { NotePropsDialog } from '../notes/NotePropsDialog'
import { md, parseNote, type Segment } from './markdown'
import styles from './NotePreview.module.css'

type NoteData = {
  path: string
  markdown: string
  vault: boolean
  job: { id: string; durationS: number | null; canSummarize: boolean; credits: number | null } | null
}

function SegmentView({ segment }: { segment: Segment }): React.JSX.Element {
  if (segment.kind === 'keywords') {
    return (
      <ul className={styles.keywords}>
        {segment.items.map((k) => (
          <li key={k}>{k}</li>
        ))}
      </ul>
    )
  }
  const html = md.render(segment.text)
  if (segment.kind === 'callout') {
    return (
      <details className={styles.callout} open={segment.open}>
        <summary>{segment.title}</summary>
        <div className={styles.calloutBody} dangerouslySetInnerHTML={{ __html: html }} />
      </details>
    )
  }
  return <div dangerouslySetInnerHTML={{ __html: html }} />
}

type Props = {
  path: string
  jobs: JobView[] | null
  llm: LlmStatus | null
  onBack: () => void
  /** 키 없이 만든 노트의 [요약 만들기]: 설정의 요약 서비스로 */
  onConnect: () => void
  /** 정보를 수정해 파일 이름이나 폴더가 바뀌었을 때: 새 경로로 다시 연다 */
  onMoved: (newPath: string) => void
  /** 노트를 삭제했을 때: 이 미리보기를 닫고 목록을 다시 읽는다 */
  onDeleted: () => void
}

// 노트 미리보기: 저장된 .md를 읽어 옵시디언과 비슷한 모양으로 보여 준다. 편집은 옵시디언이나 다른 편집기에서 한다.
export function NotePreview({ path, jobs, llm, onBack, onConnect, onMoved, onDeleted }: Props): React.JSX.Element {
  const toast = useToast()
  const [note, setNote] = useState<NoteData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [starting, setStarting] = useState(false)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(() => {
    call<NoteData>('notes.read', path).then(
      (n) => {
        setNote(n)
        setError(null)
      },
      (e) => setError(e instanceof ApiError ? e.message : '노트를 읽지 못했어요.')
    )
  }, [path])

  useEffect(load, [load])

  // Esc로 돌아간다. 확인 창이 열려 있으면 Esc는 그 창만 닫는다
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return
      onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  const parsed = useMemo(() => (note ? parseNote(note.markdown) : null), [note])

  // 요약을 (다시) 만드는 중인 작업. 끝나면 노트를 다시 읽는다 (끝남·실패 알림은 Shell이 띄운다)
  const job = note?.job ? (jobs?.find((j) => j.id === note.job!.id) ?? null) : null
  const working = job !== null && isActive(job)
  const wasWorking = useRef(false)
  useEffect(() => {
    if (wasWorking.current && !working && job?.status === 'done') load()
    wasWorking.current = working
  }, [working, job, load])

  async function open(method: string): Promise<void> {
    try {
      await call(method, path)
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '열지 못했어요.', 'danger')
    }
  }

  async function summarize(): Promise<void> {
    setConfirm(false)
    setStarting(true)
    try {
      await call('jobs.resummarize', note!.job!.id)
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '요약을 시작하지 못했어요.', 'danger')
    } finally {
      setStarting(false)
    }
  }

  // 노트 안의 링크는 창 안에서 따라가지 않는다 (웹 주소만 브라우저로)
  function onBodyClick(e: MouseEvent): void {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) void call('notes.openLink', href)
  }

  if (error) {
    return (
      <div className={styles.preview}>
        <Button variant="link" onClick={onBack}>
          ← 돌아가기
        </Button>
        <Banner tone="danger">{error}</Banner>
      </div>
    )
  }
  if (!note || !parsed) return <div className={styles.preview} />

  const meta = parsed.meta
  const title = parsed.title ?? (typeof meta['title'] === 'string' ? meta['title'] : null) ?? path.split(/[\\/]/).pop()!.replace(/\.md$/i, '')
  const hasSummary = typeof meta['llm'] === 'string'
  const canSummarize = !!note.job?.canSummarize
  const connected = !!llm?.provider
  const metaLine = [
    typeof meta['subject'] === 'string' ? meta['subject'] : null,
    typeof meta['date'] === 'string' ? meta['date'] : null,
    note.job?.durationS ? lengthMinutes(note.job.durationS) : null,
    typeof meta['stt'] === 'string' ? '이 PC 받아쓰기' : null,
    hasSummary ? `${meta['llm']} 요약` : typeof meta['stt'] === 'string' ? '요약 없음' : null
  ].filter(Boolean)

  return (
    <article className={styles.preview}>
      <Button variant="link" className={styles.back} onClick={onBack}>
        ← 돌아가기
      </Button>

      <header className={styles.head}>
        <h1>{title}</h1>
        {metaLine.length > 0 && <p className={styles.meta}>{metaLine.join(' · ')}</p>}
        <div className={styles.actions}>
          <Button size="sm" onClick={() => void open('notes.reveal')}>
            폴더에서 보기
          </Button>
          {note.vault ? (
            <Button size="sm" onClick={() => void open('notes.openObsidian')}>
              옵시디언에서 열기
            </Button>
          ) : (
            <Button size="sm" onClick={() => void open('notes.open')}>
              다른 앱에서 열기
            </Button>
          )}
          {hasSummary && canSummarize && (
            <Button
              size="sm"
              variant="ghost"
              disabled={working || starting || !connected}
              title={connected ? undefined : '요약 서비스를 연결하면 쓸 수 있어요'}
              onClick={() => setConfirm(true)}
            >
              요약 다시 만들기
            </Button>
          )}
          <MoreMenu
            label="노트 더 보기"
            items={[
              ...(typeof meta['stt'] === 'string' ? [{ label: '수정', onClick: () => setEditing(true), disabled: working }] : []),
              { label: '삭제', onClick: () => setDeleting(true), danger: true, disabled: working }
            ]}
          />
        </div>
      </header>

      {working && job && (
        <Banner tone="info" title="요약을 만드는 중이에요">
          {job.stage ? `${STAGE_LABEL[job.stage]} 중` : '앞의 작업이 끝나면 시작해요'} · 끝나면 이 화면이 새로 바뀌어요.
        </Banner>
      )}
      {!hasSummary && canSummarize && !working && (
        <Banner
          tone="info"
          title={connected ? '요약을 만들 수 있어요' : '키를 넣으면 요약을 만들 수 있어요'}
          action={
            <Button size="sm" disabled={starting} onClick={() => (connected ? setConfirm(true) : onConnect())}>
              요약 만들기
            </Button>
          }
        >
          받아쓰기는 다시 하지 않고 요약과 주요 키워드를 더해요.
        </Banner>
      )}

      <div className={styles.body} onClick={onBodyClick}>
        {parsed.segments.map((s, i) => (
          <SegmentView key={i} segment={s} />
        ))}
      </div>

      {deleting && <NoteDeleteDialog path={path} title={title} onClose={() => setDeleting(false)} onDeleted={onDeleted} />}
      {editing && <NotePropsDialog path={path} onClose={() => setEditing(false)} onSaved={(next) => (next === path ? load() : onMoved(next))} />}

      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={hasSummary ? '요약을 다시 만들까요?' : '요약을 만들까요?'}
        actions={
          <>
            <Button onClick={() => setConfirm(false)}>취소</Button>
            <Button variant="primary" onClick={() => void summarize()}>
              {hasSummary ? '다시 만들기' : '만들기'}
            </Button>
          </>
        }
      >
        <p className={styles.dialogText}>
          받아쓰기는 다시 하지 않아요. 지금 노트 파일을 덮어쓰니, 노트를 직접 고쳤다면 그 내용은 사라져요.
          {llm?.provider === 'chatkhu' && note.job?.credits != null && ` 약 ${note.job.credits}크레딧을 써요.`}
        </p>
      </Dialog>
    </article>
  )
}
