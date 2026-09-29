import { forwardRef, type ReactNode } from 'react'
import { cx } from '../components/cx'
import styles from './Settings.module.css'

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

/** 카드 안 여러 줄짜리 칸 (선택지·입력칸) */
export function Block({ title, children }: { title?: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className={styles.block}>
      {title && <div className={styles.blockTitle}>{title}</div>}
      {children}
    </div>
  )
}

/** "875MB", "1.08GB" */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)}GB`
  const mb = bytes / 1e6
  return mb >= 10 ? `${Math.round(mb).toLocaleString()}MB` : `${Math.round(mb * 10) / 10}MB`
}
