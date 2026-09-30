import { useId, type ReactNode } from 'react'
import { cx } from './cx'
import styles from './Switch.module.css'

type Props = {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  /** 아래 작은 설명 */
  hint?: ReactNode
  disabled?: boolean
}

// 켜고 끄는 설정 한 줄: 왼쪽에 이름·설명, 오른쪽에 토글 스위치 (예: 실험 기능). 바로 저장되는 설정에 쓴다.
export function Switch({ checked, onChange, label, hint, disabled }: Props): React.JSX.Element {
  const labelId = useId()
  const hintId = useId()
  return (
    <div className={cx(styles.row, disabled && styles.disabled)}>
      <div className={styles.text}>
        <span id={labelId} className={styles.label}>
          {label}
        </span>
        {hint && (
          <span id={hintId} className={styles.hint}>
            {hint}
          </span>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={hint ? hintId : undefined}
        disabled={disabled}
        className={cx(styles.track, checked && styles.on)}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.knob} aria-hidden="true" />
      </button>
    </div>
  )
}
