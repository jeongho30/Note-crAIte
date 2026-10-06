import { useId, type ComponentProps } from 'react'
import { cx } from './cx'
import { Field, describedBy } from './Field'
import styles from './Field.module.css'

type Props = ComponentProps<'textarea'> & {
  label: string
  hint?: string
  error?: string
}

// 여러 줄 입력칸. TextField와 같은 모양이고 높이는 rows로 정한다.
export function TextArea({ label, hint, error, id, className, ...rest }: Props): React.JSX.Element {
  const autoId = useId()
  const fieldId = id ?? autoId
  return (
    <Field id={fieldId} label={label} hint={hint} error={error}>
      <textarea
        {...rest}
        id={fieldId}
        className={cx(styles.control, styles.area, error && styles.invalid, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fieldId, hint, error)}
      />
    </Field>
  )
}
