import { useEffect, useId, useRef, type ReactNode } from 'react'
import styles from './Dialog.module.css'

type Props = {
  open: boolean
  /** Esc를 누르거나 닫힐 때 */
  onClose: () => void
  title: string
  children?: ReactNode
  /** 오른쪽 아래 버튼들. 주 버튼을 마지막에 둔다 */
  actions?: ReactNode
}

// 기본 <dialog>의 showModal()을 쓴다: 초점 가두기, Esc, 뒤 가림막을 브라우저가 처리한다.
// 바깥을 눌러도 닫지 않는다(지우기 확인 같은 대화상자가 실수로 닫히지 않게).
export function Dialog({ open, onClose, title, children, actions }: Props): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog ref={ref} className={styles.dialog} aria-labelledby={titleId} onClose={onClose}>
      <h2 id={titleId} className={styles.title}>
        {title}
      </h2>
      {children && <div className={styles.body}>{children}</div>}
      {actions && <div className={styles.actions}>{actions}</div>}
    </dialog>
  )
}
