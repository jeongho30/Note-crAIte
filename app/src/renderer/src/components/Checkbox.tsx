import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Checkbox.module.css'

type Props = {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  /** 아래 작은 설명 */
  hint?: ReactNode
  disabled?: boolean
}

// 켜고 끄는 선택 하나 (예: "PC를 켜면 자동으로 실행"). 기본 체크박스를 쓰고 모양만 맞춘다.
export function Checkbox({ checked, onChange, label, hint, disabled }: Props): React.JSX.Element {
  return (
    <label className={cx(styles.item, disabled && styles.disabled)}>
      <input type="checkbox" className={styles.input} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className={styles.text}>
        <span className={styles.label}>{label}</span>
        {hint && <span className={styles.hint}>{hint}</span>}
      </span>
    </label>
  )
}
