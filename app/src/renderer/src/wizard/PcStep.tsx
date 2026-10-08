import { useEffect, useState } from 'react'
import { call } from '../api'
import { Banner, Button, Card, ProgressBar, RadioCardGroup } from '../components'
import { gb, gpuLabel, mb, percent, useSetup, type StepProps } from './shared'
import { Step } from './Step'
import styles from './Wizard.module.css'
import { GPU, GPU_PC_ADVICE, PC, PC_OBJ } from '../platform'

type SystemInfo = { cpu: string; cores: number; gpus: string[]; ramGb: number; freeBytes: number }
type Choice = { id: string; size: number; downloaded: boolean }

const MODEL_TEXT: Record<string, { title: string; description: string }> = {
  'large-v3-turbo-q8_0': { title: '기본', description: `turbo. 대부분의 ${PC}에 맞아요.` },
  'large-v3-q5_0': { title: '정확하게', description: `large-v3. ${GPU_PC_ADVICE}`.trim() },
  'small-q5_1': { title: '가볍게', description: `small. 느린 ${PC}용, 정확도가 낮아요.` }
}

// 모델은 [받기 시작]을 눌러야 받는다(데이터 요금제에서 모르고 받지 않게). 건너뛰면 녹음을 넣을 때 받는다.
export function PcStep({ next, back, headingRef }: StepProps): React.JSX.Element {
  const setup = useSetup()
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [choices, setChoices] = useState<Choice[]>([])
  // 모델 카드는 접어 둔다. [다른 모델 고르기]를 누르거나 이미 기본이 아닌 모델을 골랐으면 펼친다
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    call<SystemInfo>('system.info').then(setInfo, () => setInfo(null))
    call<{ choices: Choice[] }>('stt.options').then((o) => setChoices(o.choices))
  }, [])

  const model = setup?.model
  const probe = setup?.probe
  const need = model ? model.total - model.done : 0
  const lowDisk = info !== null && model !== undefined && model.state !== 'ready' && info.freeBytes < need
  const notStarted = model?.state === 'missing' || model?.state === 'error'

  return (
    <Step
      title={`이 ${PC}에 맞게 받아쓰기를 준비할게요`}
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
        {info && info.gpus.length > 0 && (
          <>
            <dt>{GPU}</dt>
            <dd>{info.gpus.join(' · ')}</dd>
          </>
        )}
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
          {choices.length > 0 && !picking && setup.name === choices[0].id && (
            <p className={styles.small}>
              기본 모델을 써요. 대부분의 {PC}에 맞아요.{' '}
              <Button variant="link" onClick={() => setPicking(true)}>
                다른 모델 고르기
              </Button>
            </p>
          )}
          {choices.length > 0 && (picking || setup.name !== choices[0].id) && (
            <RadioCardGroup
              label="받아쓰기 모델"
              columns={3}
              value={setup.name}
              disabled={model.state === 'downloading'}
              onChange={(v) => void call('setup.pickModel', v)}
              options={choices.map((c) => ({ value: c.id, title: MODEL_TEXT[c.id]?.title ?? c.id, description: MODEL_TEXT[c.id]?.description, meta: mb(c.size) }))}
            />
          )}
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

      {model && model.state !== 'ready' && <p className={styles.small}>다 받으면 짧은 샘플로 이 {PC}의 받아쓰기 속도를 재요.</p>}
      {probe?.state === 'running' && <p className={styles.small}>이 {PC}의 받아쓰기 속도를 재고 있어요. 잠시만 기다려 주세요.</p>}
      {probe?.state === 'done' &&
        (probe.gpuName ? (
          <Banner tone="success">
            {GPU}({gpuLabel(probe.gpuName)})로 받아써요 · 90분 강의 약 {probe.minutesFor90}분
          </Banner>
        ) : (
          <Banner tone="success">
            이 {PC}의 프로세서로 받아써요 · 90분 강의 약 {probe.minutesFor90}분. 처리는 뒤에서 진행돼요. {PC_OBJ} 계속 쓰셔도 돼요.
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
