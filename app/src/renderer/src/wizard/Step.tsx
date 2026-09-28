import type { ReactNode, RefObject } from 'react'
import styles from './Wizard.module.css'

type Props = {
  title: string
  description?: ReactNode
  headingRef: RefObject<HTMLHeadingElement | null>
  children?: ReactNode
  /** 아래 버튼 줄 */
  actions: ReactNode
}

// 마법사 한 단계의 틀: 제목, 설명, 내용, 버튼 줄.
export function Step({ title, description, headingRef, children, actions }: Props): React.JSX.Element {
  return (
    <section className={styles.step}>
      {/* 단계가 바뀌면 초점을 제목으로 옮겨 화면 읽기 프로그램이 새 단계를 읽게 한다 */}
      <h1 ref={headingRef} tabIndex={-1} className={styles.title}>
        {title}
      </h1>
      {description && <p className={styles.description}>{description}</p>}
      {children}
      <div className={styles.actions}>{actions}</div>
    </section>
  )
}
