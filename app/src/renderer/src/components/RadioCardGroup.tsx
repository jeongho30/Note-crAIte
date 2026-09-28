import { useId, type ReactNode } from 'react'
import { cx } from './cx'
import styles from './RadioCardGroup.module.css'

type Option<T> = {
  value: T
  title: string
  description?: ReactNode
  /** 오른쪽에 붙는 짧은 정보 (예: "약 27분", "약 540크레딧") */
  meta?: ReactNode
  /** 이 선택지만 고를 수 없게 (예: 곧 지원) */
  disabled?: boolean
}

type Props<T extends string> = {
  /** 화면 읽기 프로그램용 이름 (예: "받아쓰기 방식") */
  label: string
  value: T
  options: Option<T>[]
  onChange: (value: T) => void
  disabled?: boolean
}

// 설명이 필요한 선택지 중 하나 (예: 받아쓰기 방식). 같은 name의 라디오라 화살표 키로 옮겨 다닌다.
export function RadioCardGroup<T extends string>({ label, value, options, onChange, disabled }: Props<T>): React.JSX.Element {
  const name = useId()
  return (
    <div role="radiogroup" aria-label={label} className={cx(styles.group, disabled && styles.disabled)}>
      {options.map((o) => (
        <label key={o.value} className={cx(styles.card, o.value === value && styles.selected, o.disabled && styles.cardDisabled)}>
          <input
            type="radio"
            className={styles.input}
            name={name}
            value={o.value}
            checked={o.value === value}
            disabled={disabled || o.disabled}
            onChange={() => onChange(o.value)}
          />
          <span className={styles.indicator} aria-hidden="true" />
          <span className={styles.body}>
            <span className={styles.title}>{o.title}</span>
            {o.description && <span className={styles.description}>{o.description}</span>}
          </span>
          {o.meta && <span className={styles.meta}>{o.meta}</span>}
        </label>
      ))}
    </div>
  )
}
