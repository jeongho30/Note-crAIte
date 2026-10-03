import { useId } from 'react'
import { cx } from './cx'
import styles from './SegmentedControl.module.css'

type Props<T extends string> = {
  /** 화면 읽기 프로그램용 이름 (예: "강의 언어") */
  label: string
  value: T
  /** disabled: 그 선택지만 고를 수 없게 */
  options: { value: T; label: string; disabled?: boolean }[]
  onChange: (value: T) => void
  disabled?: boolean
}

// 짧은 선택지 두세 개 중 하나 (예: 한국어/영어). 같은 name의 라디오라 화살표 키로 옮겨 다닌다.
export function SegmentedControl<T extends string>({ label, value, options, onChange, disabled }: Props<T>): React.JSX.Element {
  const name = useId()
  return (
    <div role="radiogroup" aria-label={label} className={cx(styles.group, disabled && styles.disabled)}>
      {options.map((o) => (
        <label key={o.value} className={cx(styles.option, o.value === value && styles.selected, o.disabled && styles.off)}>
          <input
            type="radio"
            className={styles.input}
            name={name}
            value={o.value}
            checked={o.value === value}
            disabled={disabled || o.disabled}
            onChange={() => onChange(o.value)}
          />
          {o.label}
        </label>
      ))}
    </div>
  )
}
