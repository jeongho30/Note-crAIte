import { useId, type ComponentProps } from 'react'
import { cx } from './cx'
import { Field, describedBy } from './Field'
import styles from './Field.module.css'

type Props = ComponentProps<'input'> & {
  label: string
  hint?: string
  error?: string
}

export function TextField({ label, hint, error, id, className, ...rest }: Props): React.JSX.Element {
  const autoId = useId()
  const fieldId = id ?? autoId
  return (
    <Field id={fieldId} label={label} hint={hint} error={error}>
      <input
        {...rest}
        id={fieldId}
        className={cx(styles.control, error && styles.invalid, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fieldId, hint, error)}
      />
    </Field>
  )
}
