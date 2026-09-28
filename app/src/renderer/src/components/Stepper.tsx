import { cx } from './cx'
import styles from './Stepper.module.css'

type Props = {
  steps: string[]
  /** 지금 단계 (0부터) */
  current: number
}

// 첫 실행 마법사의 단계 표시줄. 지난 단계, 지금 단계, 남은 단계를 구분한다.
export function Stepper({ steps, current }: Props): React.JSX.Element {
  return (
    <ol className={styles.stepper}>
      {steps.map((label, i) => (
        <li
          key={label}
          className={cx(styles.step, i < current && styles.done, i === current && styles.current)}
          aria-current={i === current ? 'step' : undefined}
        >
          <span className={styles.number}>{i + 1}</span>
          <span className={styles.label}>{label}</span>
        </li>
      ))}
    </ol>
  )
}
