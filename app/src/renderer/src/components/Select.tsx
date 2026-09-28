import { useId, type ComponentProps } from 'react'
import { cx } from './cx'
import { Field, describedBy } from './Field'
import styles from './Field.module.css'

type Props = ComponentProps<'select'> & {
  label: string
  hint?: string
  error?: string
}

// 기본 select를 그대로 쓴다(키보드·접근성은 브라우저가 처리). 선택지는 <option>을 children으로 넘긴다.
export function Select({ label, hint, error, id, className, ...rest }: Props): React.JSX.Element {
  const autoId = useId()
  const fieldId = id ?? autoId
  return (
    <Field id={fieldId} label={label} hint={hint} error={error}>
      <div className={styles.selectWrap}>
        <select
          {...rest}
          id={fieldId}
          className={cx(styles.control, styles.select, error && styles.invalid, className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(fieldId, hint, error)}
        />
      </div>
    </Field>
  )
}
