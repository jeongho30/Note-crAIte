import type { ComponentProps, ReactNode } from 'react'
import { cx } from './cx'
import styles from './ListRow.module.css'

type Props = Omit<ComponentProps<'div'>, 'title'> & {
  title: ReactNode
  description?: ReactNode
  /** 오른쪽 정보 (예: 상태 알약, 시간) */
  meta?: ReactNode
  /** 오른쪽 끝 버튼 */
  actions?: ReactNode
  selected?: boolean
}

// 목록 한 줄의 배치만 맡는다. 줄 전체를 누르게 하려면 title에 버튼이나 링크를 넣는다.
export function ListRow({ title, description, meta, actions, selected, className, ...rest }: Props): React.JSX.Element {
  return (
    <div className={cx(styles.row, selected && styles.selected, className)} {...rest}>
      <div className={styles.main}>
        <div className={styles.title}>{title}</div>
        {description && <div className={styles.description}>{description}</div>}
      </div>
      {meta && <div className={styles.meta}>{meta}</div>}
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  )
}
