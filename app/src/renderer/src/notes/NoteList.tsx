import { useEffect, useMemo, useState } from 'react'
import { ApiError, call } from '../api'
import { Button, Card, Select, StatusPill, TextField, useToast } from '../components'
import type { RecentNote } from '../../../core/recent'
import { filterNotes, type Sort, type SubjectFilter } from './filter'
import styles from './NoteList.module.css'

const PAGE = 20
const ALL = '\u0000all'
const NONE = '\u0000none'

function toFilter(value: string): SubjectFilter {
  if (value === ALL) return { kind: 'all' }
  if (value === NONE) return { kind: 'none' }
  return { kind: 'subject', name: value }
}

type Props = {
  /** 끝난 작업 수 (바뀌면 다시 읽는다) */
  doneCount: number
  onPreview: (path: string) => void
}

// 노트 목록: 저장 폴더의 노트 전체. 제목·과목으로 찾고, 과목으로 거르고, 최근 수정 순 또는 강의 날짜 순으로 본다.
export function NoteList({ doneCount, onPreview }: Props): React.JSX.Element {
  const toast = useToast()
  const [notes, setNotes] = useState<RecentNote[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [subject, setSubject] = useState(ALL)
  const [sort, setSort] = useState<Sort>('modified')
  const [shown, setShown] = useState(PAGE)

  useEffect(() => {
    call<RecentNote[]>('notes.list').then(
      (n) => {
        setNotes(n)
        setError(null)
      },
      (e) => setError(e instanceof ApiError ? e.message : '노트를 읽지 못했어요.')
    )
  }, [doneCount])

  // 찾는 조건이 바뀌면 처음 20개부터
  useEffect(() => setShown(PAGE), [query, subject, sort])

  const subjects = useMemo(() => [...new Set((notes ?? []).map((n) => n.subject).filter((s): s is string => s !== null))].sort(), [notes])
  const hasUnfiled = !!notes?.some((n) => n.subject === null)
  const found = useMemo(() => filterNotes(notes ?? [], query, toFilter(subject), sort), [notes, query, subject, sort])

  async function openFolder(): Promise<void> {
    try {
      await call('folder.openOut')
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '열지 못했어요.', 'danger')
    }
  }

  return (
    <div className={styles.list}>
      <div className={styles.head}>
        <h1>
          노트 목록{notes && notes.length > 0 && <span>{notes.length}개</span>}
        </h1>
        <Button variant="link" onClick={() => void openFolder()}>
          저장 폴더 열기
        </Button>
      </div>

      {error && <p className={styles.empty}>{error}</p>}

      {notes && notes.length === 0 && (
        <div className={styles.empty}>
          <b>아직 노트가 없어요</b>
          홈에서 녹음을 넣으면 저장 폴더에 노트가 생기고 여기에 모여요.
        </div>
      )}

      {notes && notes.length > 0 && (
        <>
          <div className={styles.controls}>
            <div className={styles.search}>
              <TextField label="찾기" type="search" placeholder="제목이나 과목" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <Select label="과목" value={subject} onChange={(e) => setSubject(e.target.value)}>
              <option value={ALL}>모든 과목</option>
              {subjects.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              {hasUnfiled && <option value={NONE}>미분류</option>}
            </Select>
            <Select label="정렬" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="modified">최근 수정 순</option>
              <option value="date">강의 날짜 순</option>
            </Select>
          </div>

          {found.length === 0 ? (
            <p className={styles.empty}>찾는 노트가 없어요.</p>
          ) : (
            <Card className={styles.notes}>
              {found.slice(0, shown).map((n) => (
                <button key={n.path} className={styles.note} onClick={() => onPreview(n.path)}>
                  <StatusPill>{n.subject ?? '미분류'}</StatusPill>
                  <span className={styles.title} title={n.title}>
                    {n.title}
                  </span>
                  <span className={styles.meta}>{n.date}</span>
                </button>
              ))}
            </Card>
          )}

          {found.length > shown && (
            <Button className={styles.more} onClick={() => setShown(shown + PAGE)}>
              더 보기 ({found.length - shown}개)
            </Button>
          )}
        </>
      )}
    </div>
  )
}
