import type { ComponentProps } from 'react'
import { cx } from './cx'
import styles from './Button.module.css'

type Props = ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  /** sm: 표 안, md: 기본, lg: 첫 실행 마법사 */
  size?: 'sm' | 'md' | 'lg'
}

export function Button({ variant = 'secondary', size = 'md', type = 'button', className, ...rest }: Props): React.JSX.Element {
  return <button type={type} className={cx(styles.button, styles[variant], styles[size], className)} {...rest} />
}
