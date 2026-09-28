import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Banner.module.css'

type Props = {
  tone: 'success' | 'warning' | 'danger'
  /** 짧은 머리말 (예: "주의", "실패") */
  title?: string
  children: ReactNode
  /** 오른쪽 버튼 (예: [전사만 저장]) */
  action?: ReactNode
}

// 오류 문구는 "무엇이 잘못됐는지 + 할 일"로 쓴다.
export function Banner({ tone, title, children, action }: Props): React.JSX.Element {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx(styles.banner, styles[tone])}>
      <p className={styles.text}>
        {title && <strong className={styles.title}>{title}</strong>}
        {children}
      </p>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  )
}
