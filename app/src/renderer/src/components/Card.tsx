import type { ComponentProps } from 'react'
import { cx } from './cx'
import styles from './Card.module.css'

// 그림자 없이 테두리로 구분하는 면.
export function Card({ className, ...rest }: ComponentProps<'div'>): React.JSX.Element {
  return <div className={cx(styles.card, className)} {...rest} />
}
