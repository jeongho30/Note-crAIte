import { useEffect, useState } from 'react'
import { call } from '../api'
import { Banner, Button, Card, ProgressBar } from '../components'
import { gb, gpuLabel, mb, percent, useSetup, type StepProps } from './shared'
import { Step } from './Step'
import styles from './Wizard.module.css'

type SystemInfo = { cpu: string; cores: number; ramGb: number; freeBytes: number }

// 모델은 [받기 시작]을 눌러야 받는다(데이터 요금제에서 모르고 받지 않게). 건너뛰면 녹음을 넣을 때 받는다.
export function PcStep({ next, back, headingRef }: StepProps): React.JSX.Element {
  const setup = useSetup()
  const [info, setInfo] = useState<SystemInfo | null>(null)

  useEffect(() => {
    call<SystemInfo>('system.info').then(setInfo, () => setInfo(null))
  }, [])

  const model = setup?.model
  const probe = setup?.probe
  const need = model ? model.total - model.done : 0
  const lowDisk = info !== null && model !== undefined && model.state !== 'ready' && info.freeBytes < need
  const notStarted = model?.state === 'missing' || model?.state === 'error'

  return (
    <Step
      title="이 PC에 맞게 받아쓰기를 준비할게요"
      headingRef={headingRef}
      actions={
        <>
          <Button variant="ghost" className={styles.back} onClick={back}>
            이전
          </Button>
          {notStarted ? (
            <Button onClick={next}>건너뛰기</Button>
          ) : (
            <Button variant="primary" size="lg" onClick={next}>
              다음
            </Button>
          )}
        </>
      }
    >
      <dl className={styles.facts}>
        <dt>프로세서</dt>
        <dd>{info ? `${info.cpu} · ${info.cores}코어` : '확인 중…'}</dd>
        <dt>메모리</dt>
        <dd>{info ? `${info.ramGb}GB` : '확인 중…'}</dd>
        <dt>남은 공간</dt>
        <dd>{info ? gb(info.freeBytes) : '확인 중…'}</dd>
      </dl>

      {model && (
        <Card>
          <div className={styles.cardHead}>
            <span>받아쓰기 모델</span>
            <span className={styles.small}>{mb(model.total)}</span>
          </div>
          {notStarted && (
            <>
              <p className={styles.small}>처음 한 번만 받아요. 와이파이에서 받는 걸 권해요.</p>
              {model.error && <Banner tone="danger">{model.error}</Banner>}
              <div>
                <Button variant="primary" disabled={lowDisk} onClick={() => void call('setup.download')}>
                  {model.done > 0 ? '이어 받기' : '받기 시작'}
                </Button>
              </div>
            </>
          )}
          {model.state === 'downloading' && (
            <>
              <ProgressBar value={model.done / model.total} label="받아쓰기 모델 받기" />
              <p className={styles.small}>받는 중 {percent(model.done, model.total)}% · 다음 단계를 진행해도 돼요</p>
            </>
          )}
          {model.state === 'ready' && <p className={styles.small}>다 받았어요.</p>}
        </Card>
      )}

      {lowDisk && <Banner tone="danger">남은 공간이 부족해요. 받아쓰기 모델에 {gb(need)}가 필요해요.</Banner>}

      {model && model.state !== 'ready' && <p className={styles.small}>다 받으면 짧은 샘플로 이 PC의 받아쓰기 속도를 재요.</p>}
      {probe?.state === 'running' && <p className={styles.small}>이 PC의 받아쓰기 속도를 재고 있어요. 잠시만 기다려 주세요.</p>}
      {probe?.state === 'done' &&
        (probe.gpuName ? (
          <Banner tone="success">
            그래픽카드({gpuLabel(probe.gpuName)})로 받아써요 · 90분 강의 약 {probe.minutesFor90}분
          </Banner>
        ) : (
          <Banner tone="success">
            이 PC의 프로세서로 받아써요 · 90분 강의 약 {probe.minutesFor90}분. 처리는 뒤에서 진행돼요. PC를 계속 쓰셔도 돼요.
          </Banner>
        ))}
      {probe?.state === 'error' && (
        <Banner tone="warning" title="주의">
          받아쓰기 속도를 재지 못했어요. 받아쓰기는 프로세서로 해요.
        </Banner>
      )}
    </Step>
  )
}
