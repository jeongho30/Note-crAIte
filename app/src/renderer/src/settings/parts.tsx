import { forwardRef, useState, type ReactNode } from 'react'
import { cx } from '../components/cx'
import styles from './Settings.module.css'

/** 접는 제목 버튼: 앞의 화살표가 열림 상태를 보인다 */
function FoldHead({ open, onToggle, className, children }: { open: boolean; onToggle: () => void; className: string; children: ReactNode }): React.JSX.Element {
  return (
    <button type="button" className={cx(className, open && styles.foldOpen)} aria-expanded={open} onClick={onToggle}>
      <span className={styles.chev} aria-hidden="true" />
      {children}
    </button>
  )
}

/** 설정 묶음 하나: 작은 제목 + 카드 + 카드 아래 안내 */
export const Section = forwardRef<HTMLElement, { title?: string; hint?: ReactNode; children: ReactNode }>(function Section(
  { title, hint, children },
  ref
) {
  return (
    <section ref={ref} className={styles.sec} aria-label={title}>
      {title && <h2>{title}</h2>}
      {children}
      {hint && <p className={styles.hint}>{hint}</p>}
    </section>
  )
})

export function SettingsCard({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className={styles.card}>{children}</div>
}

/** 카드 안 한 줄: 제목·설명과 오른쪽 버튼 */
export function Row({ title, sub, ctrl, dim }: { title: ReactNode; sub?: ReactNode; ctrl?: ReactNode; dim?: boolean }): React.JSX.Element {
  return (
    <div className={cx(styles.row, dim && styles.dim)}>
      <div className={styles.label}>
        <b>{title}</b>
        {sub && <span>{sub}</span>}
      </div>
      {ctrl && <div className={styles.ctrl}>{ctrl}</div>}
    </div>
  )
}

/** 카드 안 여러 줄짜리 칸 (선택지·입력칸). foldable이면 처음엔 접혀 있고 제목을 눌러 펼친다(접힘 상태는 저장하지 않음) */
export function Block({ title, foldable, children }: { title?: string; foldable?: boolean; children: ReactNode }): React.JSX.Element {
  const fold = !!(foldable && title)
  const [open, setOpen] = useState(!fold)
  return (
    <div className={styles.block}>
      {title &&
        (fold ? (
          <FoldHead open={open} onToggle={() => setOpen(!open)} className={styles.blockFold}>
            {title}
          </FoldHead>
        ) : (
          <div className={styles.blockTitle}>{title}</div>
        ))}
      {(!fold || open) && children}
    </div>
  )
}

/** "875MB", "1.08GB" */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)}GB`
  const mb = bytes / 1e6
  return mb >= 10 ? `${Math.round(mb).toLocaleString()}MB` : `${Math.round(mb * 10) / 10}MB`
}
