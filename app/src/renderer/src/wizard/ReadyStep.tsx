import { useEffect, useState } from 'react'
import { call } from '../api'
import { Button, Card, ListRow } from '../components'
import type { Settings } from '../../../core/settings'
import type { FolderInfo } from '../../../core/vault'
import { sttSummary, useSetup, type LlmStatus, type StepProps } from './shared'
import { Step } from './Step'
import styles from './Wizard.module.css'

const PROVIDER_STEP = 2

export function ReadyStep({ back, goTo, headingRef, finish }: StepProps & { finish: () => Promise<void> }): React.JSX.Element {
  const setup = useSetup()
  const [llm, setLlm] = useState<LlmStatus | null>(null)
  const [folder, setFolder] = useState<FolderInfo | null>(null)

  useEffect(() => {
    call<LlmStatus>('llm.status').then(setLlm)
    call<Settings>('settings.get').then((s) => {
      if (s.outDir) void call<FolderInfo>('folder.inspect', s.outDir).then(setFolder)
    })
  }, [])

  const modelMissing = setup?.model.state === 'missing' || setup?.model.state === 'error'

  return (
    <Step
      title="준비됐어요"
      headingRef={headingRef}
      actions={
        <>
          <Button variant="ghost" className={styles.back} onClick={back}>
            이전
          </Button>
          <Button variant="primary" size="lg" onClick={() => void finish()}>
            첫 녹음 넣기
          </Button>
        </>
      }
    >
      <Card>
        <ListRow
          title="받아쓰기"
          description={setup ? sttSummary(setup) : '확인 중…'}
          actions={
            modelMissing && (
              <Button size="sm" onClick={() => void call('setup.download')}>
                {setup!.model.done > 0 ? '이어 받기' : '받기 시작'}
              </Button>
            )
          }
        />
        <ListRow
          title="요약"
          description={
            llm === null
              ? '확인 중…'
              : llm.provider
                ? `${llm.name}와 연동되었어요${llm.credits != null ? ` · 남은 크레딧 ${llm.credits.toLocaleString()}` : ''}`
                : '연결된 요약 서비스가 없어요 · 전사문만 만들어요'
          }
          actions={
            llm !== null &&
            !llm.provider && (
              <Button size="sm" onClick={() => goTo(PROVIDER_STEP)}>
                연결하기
              </Button>
            )
          }
        />
        <ListRow title="저장 폴더" description={folder ? `${folder.path}${folder.vaultRoot ? ' (옵시디언 볼트)' : ''}` : '확인 중…'} />
      </Card>
      {modelMissing && <p className={styles.small}>모델을 받지 않아도 시작할 수 있어요. 녹음을 넣으면 그때 받아요.</p>}
    </Step>
  )
}
