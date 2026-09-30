import { useState } from 'react'
import { ApiError, call } from '../api'
import { Banner, Button, Dialog, useToast } from '../components'
import styles from './NotePropsDialog.module.css'

type Props = {
  path: string
  title: string
  onClose: () => void
  onDeleted: () => void
}

// 노트 삭제 확인. 파일은 휴지통으로 옮겨서, 잘못 지워도 휴지통에서 되살릴 수 있다.
export function NoteDeleteDialog({ path, title, onClose, onDeleted }: Props): React.JSX.Element {
  const toast = useToast()
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove(): Promise<void> {
    setDeleting(true)
    setError(null)
    try {
      await call('notes.delete', path)
      toast('노트를 휴지통으로 옮겼어요.', 'success')
      onDeleted()
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '삭제하지 못했어요.')
      setDeleting(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="노트를 삭제할까요?"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button variant="danger" disabled={deleting} onClick={() => void remove()}>
            삭제
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        {error && <Banner tone="danger">{error}</Banner>}
        <p className={styles.muted}>
          <b>{title}</b> 노트 파일을 휴지통으로 옮겨요. 휴지통에서 되살릴 수 있어요. 작업 기록과 받아쓴 내용은 그대로 남아요.
        </p>
      </div>
    </Dialog>
  )
}
