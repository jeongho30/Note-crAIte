import type { ReactNode } from 'react'
import styles from './Field.module.css'

type Props = {
  id: string
  label: string
  hint?: string
  error?: string
  children: ReactNode
}

// 라벨, 컨트롤, 안내 또는 오류 문구 한 벌. 오류가 있으면 안내 대신 오류를 보인다.
export function Field({ id, label, hint, error, children }: Props): React.JSX.Element {
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className={styles.error}>
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className={styles.hint}>
            {hint}
          </p>
        )
      )}
    </div>
  )
}

// 컨트롤의 aria-describedby 값. Field가 보여 주는 문구와 짝을 맞춘다.
export function describedBy(id: string, hint?: string, error?: string): string | undefined {
  if (error) return `${id}-error`
  if (hint) return `${id}-hint`
  return undefined
}
