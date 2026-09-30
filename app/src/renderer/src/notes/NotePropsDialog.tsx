import { useEffect, useState } from 'react'
import { ApiError, call } from '../api'
import { Banner, Button, Dialog, Select, TextField, useToast } from '../components'
import styles from './NotePropsDialog.module.css'

type Info = { editable: true; title: string; subject: string | null; date: string } | { editable: false }
type Subjects = { subjects: string[] }

const NONE = '\u0000none'
const NEW = '\u0000new'

type Props = {
  path: string
  onClose: () => void
  /** 저장했을 때: 파일 이름이나 폴더가 바뀔 수 있어 새 경로를 준다 */
  onSaved: (newPath: string) => void
}

// 노트의 제목·과목·날짜 고치기. 머리말과 파일 이름·폴더가 함께 바뀌고 본문은 그대로다. 이 앱이 만든 노트만 고칠 수 있다.
export function NotePropsDialog({ path, onClose, onSaved }: Props): React.JSX.Element {
  const toast = useToast()
  const [ready, setReady] = useState(false)
  const [subjects, setSubjects] = useState<string[]>([])
  const [title, setTitle] = useState('')
  const [pick, setPick] = useState(NONE)
  const [newName, setNewName] = useState('')
  const [date, setDate] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 열릴 때 한 번만 읽는다
  useEffect(() => {
    Promise.all([call<Info>('notes.editInfo', path), call<Subjects>('subjects.get')]).then(
      ([info, s]) => {
        if (!info.editable) {
          toast('이 앱이 만든 노트만 고칠 수 있어요.', 'danger')
          onClose()
          return
        }
        // 폴더 이름과 머리말의 과목이 다르면(직접 옮긴 노트) 머리말의 과목도 고를 수 있게 목록에 넣는다
        setSubjects(info.subject && !s.subjects.includes(info.subject) ? [...s.subjects, info.subject] : s.subjects)
        setTitle(info.title)
        setPick(info.subject ?? NONE)
        setDate(info.date)
        setReady(true)
      },
      (e) => {
        toast(e instanceof ApiError ? e.message : '노트를 읽지 못했어요.', 'danger')
        onClose()
      }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  const subject = pick === NONE ? null : pick === NEW ? newName.trim() || null : pick
  const invalid = !title.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (pick === NEW && !newName.trim())

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const next = await call<string>('notes.edit', { path, title, subject, date })
      toast('노트 정보를 고쳤어요.', 'success')
      onSaved(next)
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '저장하지 못했어요.')
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="노트 정보 고치기"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" disabled={!ready || invalid || saving} onClick={() => void save()}>
            저장
          </Button>
        </>
      }
    >
      {!ready ? (
        <p className={styles.muted}>노트를 읽는 중이에요…</p>
      ) : (
        <div className={styles.form}>
          {error && <Banner tone="danger">{error}</Banner>}
          <TextField label="제목" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          <Select label="과목" value={pick} onChange={(e) => setPick(e.target.value)}>
            {subjects.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            <option value={NONE}>미분류 (과목 없음)</option>
            <option value={NEW}>+ 새 과목</option>
          </Select>
          {pick === NEW && (
            <TextField label="새 과목 이름" placeholder="예: 컴파일러" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} hint="저장 폴더 안에 이 이름의 폴더가 생겨요." />
          )}
          <TextField label="강의 날짜" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <p className={styles.muted}>파일 이름과 과목 폴더도 함께 바뀌어요. 노트 본문은 그대로예요. 옵시디언에서 이 노트로 건 링크는 자동으로 고쳐지지 않아요.</p>
        </div>
      )}
    </Dialog>
  )
}
