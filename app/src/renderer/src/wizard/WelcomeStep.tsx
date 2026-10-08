import { Button } from '../components'
import type { StepProps } from './shared'
import { Step } from './Step'
import styles from './Wizard.module.css'
import { PC } from '../platform'

export function WelcomeStep({ next, headingRef }: StepProps): React.JSX.Element {
  return (
    <Step
      title="강의 녹음을 노트로 만들어 드려요"
      description="녹음을 넣으면 요약, 주요 키워드, 전사문이 담긴 노트가 과목 폴더에 저장돼요."
      headingRef={headingRef}
      actions={
        <Button variant="primary" size="lg" onClick={next}>
          시작하기
        </Button>
      }
    >
      <dl className={styles.facts}>
        <dt>이 {PC}에서</dt>
        <dd>녹음을 글로 받아써요. 녹음 파일은 {PC} 밖으로 나가지 않아요.</dd>
        <dt>요약 서비스로</dt>
        <dd>요약할 때 전사문과 필기만 보내요.</dd>
      </dl>
    </Step>
  )
}
