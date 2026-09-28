import styles from './ProgressBar.module.css'

type Props = {
  /** 0~1 */
  value: number
  /** 화면 읽기 프로그램용 이름 (예: "받아쓰기 진행") */
  label: string
}

export function ProgressBar({ value, label }: Props): React.JSX.Element {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className={styles.track}>
      <div className={styles.fill} style={{ width: `${percent}%` }} />
    </div>
  )
}
