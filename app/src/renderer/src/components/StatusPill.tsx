import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './StatusPill.module.css'

type Props = {
  /** neutral: 과목 같은 꼬리표, progress: 진행 중, waiting: 대기 */
  tone?: 'neutral' | 'progress' | 'waiting' | 'success' | 'warning' | 'danger'
  /** 색만으로 상태를 전하지 않도록 항상 글자로 쓴다 (예: "받아쓰기 42%", "요약 실패") */
  children: ReactNode
  /** 마우스를 올리면 뜨는 글 (줄여 보일 때 전체 이름) */
  title?: string
  className?: string
}

export function StatusPill({ tone = 'neutral', children, title, className }: Props): React.JSX.Element {
  return (
    <span className={cx(styles.pill, styles[tone], className)} title={title}>
      {children}
    </span>
  )
}
