import { forwardRef, useEffect, useState } from 'react'
import { ApiError, call } from '../api'
import { Button, RadioCardGroup, Select, TextField, useToast } from '../components'
import { cx } from '../components/cx'
import type { SetupState } from '../../../main/setup'
import { Block, Section, sizeLabel } from './parts'
import styles from './Settings.module.css'

type Choice = { id: string; size: number; downloaded: boolean; locked: string }
type Options = { model: string; choices: Choice[]; defaultArgs: string; args: string; custom: boolean }
type SampleTest = { sampleS: number; processS: number; chars: number; ok: boolean; reason?: string }

const MODEL_TEXT: Record<string, { title: string; description: (gpu: boolean) => string }> = {
  'large-v3-turbo-q8_0': { title: '기본 · large-v3-turbo-q8_0', description: () => '대부분의 PC에 맞아요. 속도와 정확도의 균형.' },
  'large-v3-q5_0': {
    title: '더 정확하게 · large-v3',
    description: (gpu) => (gpu ? '그래픽카드 PC 권장. 기본보다 약 2배 느려요.' : '그래픽카드가 없는 이 PC에서는 아주 느려요.')
  },
  'small-q5_1': { title: '가볍게 · small', description: () => '느린 PC용. 정확도가 낮아요.' }
}

type Props = {
  setup: SetupState | null
  /** 요약 서비스가 연결돼 있어야 요약 세부설정을 바꿀 수 있다 */
  connected: boolean
  /** 받아쓰기 모델을 바꾸면 저장 공간 크기가 바뀐다 */
  onSaved: () => void
  /** 요약 세부설정을 바꾸면 남은 요약 횟수가 바뀐다 */
  onStepsSaved: () => void
}

type StepModel = { id: string; verify90: number | null; polish90: number | null }
type Steps = { verifyModel: string; polishModel: string | null; defaultModel: string; models: StepModel[] }

/** "약 0.4크레딧", 모르면 "크레딧 모름" */
function creditsLabel(v: number | null): string {
  return v == null ? '크레딧 모름' : `약 ${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)}크레딧`
}

// 고급(기본은 접힘): 받아쓰기 세부설정(모델, 실제 명령, 고칠 수 있는 옵션, 샘플로 시험), 요약 세부설정(교정 검증·전사문 다듬기 모델), 로컬 LLM(곧 지원).
export const AdvancedSection = forwardRef<HTMLElement, Props>(function AdvancedSection({ setup, connected, onSaved, onStepsSaved }, ref) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [steps, setSteps] = useState<Steps | null>(null)
  // 다듬기를 켤 때 고를 모델 (끈 동안에도 마지막으로 고른 모델을 기억)
  const [polishPick, setPolishPick] = useState<string | null>(null)

  useEffect(() => {
    if (open) call<Steps>('llm.steps').then(setSteps)
  }, [open])

  async function saveSteps(patch: { verifyModel?: string; polishModel?: string | null }): Promise<void> {
    try {
      await call('llm.setSteps', patch)
      setSteps(await call<Steps>('llm.steps'))
      onStepsSaved()
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '저장하지 못했어요.', 'danger')
    }
  }

  const polishModel = steps?.polishModel ?? polishPick ?? steps?.defaultModel ?? ''
  const polish90 = steps?.models.find((m) => m.id === polishModel)?.polish90 ?? null
  const [opts, setOpts] = useState<Options | null>(null)
  const [model, setModel] = useState('')
  const [args, setArgs] = useState('')
  const [test, setTest] = useState<{ state: 'idle' | 'running' } | { state: 'done'; result: SampleTest } | { state: 'error'; message: string }>({
    state: 'idle'
  })
  const [saving, setSaving] = useState(false)

  // 펼칠 때와, 속도를 다시 재서 기본 옵션(장치·스레드)이 바뀌었을 때 불러온다
  const probeKey = `${setup?.name}:${setup?.probe.state}:${setup?.probe.gpuDevice}:${setup?.model.state}`
  useEffect(() => {
    if (!open) return
    call<Options>('stt.options').then((o) => {
      setOpts(o)
      setModel((m) => m || o.model)
      setArgs((a) => a || o.args)
    })
  }, [open, probeKey])

  const choice = opts?.choices.find((c) => c.id === model)
  // 그래픽카드 없이 받아쓰는 PC에서는 large-v3를 고를 수 없다 (아주 느림)
  const gpu = setup?.probe.state !== 'done' || !!setup.probe.gpuName
  const dirty = !!opts && (model !== opts.model || args.trim() !== opts.args)

  async function runTest(): Promise<void> {
    setTest({ state: 'running' })
    try {
      setTest({ state: 'done', result: await call<SampleTest>('stt.test', { model, args }) })
    } catch (e) {
      setTest({ state: 'error', message: e instanceof ApiError ? e.message : '시험하지 못했어요.' })
    }
  }

  async function save(): Promise<void> {
    setSaving(true)
    try {
      const o = await call<Options>('stt.save', { model, args })
      setOpts(o)
      setModel(o.model)
      setArgs(o.args)
      toast(o.choices.find((c) => c.id === o.model)?.downloaded ? '받아쓰기 설정을 저장했어요.' : '저장했어요. 모델을 받은 뒤 이 PC의 속도를 다시 재요.', 'success')
      onSaved()
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '저장하지 못했어요.', 'danger')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section ref={ref}>
      <div className={cx(styles.adv, open && styles.open)}>
        <button className={styles.advHead} aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={styles.chev} aria-hidden="true" />
          <b>고급</b>
          <span>받아쓰기 세부설정 · 요약 세부설정 · 로컬 LLM</span>
        </button>
        {open && (
          <div className={styles.advBody}>
            <Block title="받아쓰기 세부설정">
              {!opts ? (
                <p className={styles.hint}>불러오는 중…</p>
              ) : (
                <>
                  <RadioCardGroup
                    label="받아쓰기 모델"
                    value={model}
                    onChange={(v) => {
                      setModel(v)
                      setTest({ state: 'idle' })
                    }}
                    options={opts.choices.map((c) => ({
                      value: c.id,
                      title: MODEL_TEXT[c.id]?.title ?? c.id,
                      description: MODEL_TEXT[c.id]?.description(gpu),
                      meta: `${sizeLabel(c.size)} · ${c.downloaded ? '받음' : '받아야 해요'}`,
                      disabled: c.id === 'large-v3-q5_0' && !gpu && opts.model !== c.id
                    }))}
                  />
                  <p className={styles.hint}>모델을 바꾸면 받은 뒤 이 PC의 속도를 다시 재고, 예상 시간도 바뀌어요.</p>

                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>실제로 부르는 명령</span>
                    <p className={styles.code}>
                      {choice?.locked} <mark>{args.trim()}</mark>
                    </p>
                  </div>
                  <p className={styles.hint}>색칠된 옵션만 고칠 수 있어요. 파일·모델·언어·출력 형식은 앱이 정해요(강의 언어는 과목에서).</p>

                  <TextField
                    label="고칠 수 있는 옵션"
                    className={styles.mono}
                    spellCheck={false}
                    autoComplete="off"
                    value={args}
                    onChange={(e) => {
                      setArgs(e.target.value)
                      setTest({ state: 'idle' })
                    }}
                  />

                  {test.state === 'running' && <p className={styles.result}>샘플을 받아쓰는 중이에요…</p>}
                  {test.state === 'done' &&
                    (test.result.ok ? (
                      <p className={styles.result}>
                        <span className={styles.ok}>✓ 샘플로 시험함</span>
                        {Math.round(test.result.sampleS)}초 샘플 · {test.result.processS.toFixed(1)}초 · {test.result.chars.toLocaleString()}자 · 정상
                      </p>
                    ) : (
                      <p className={styles.result}>
                        <span className={styles.bad}>✕ 이상 있음</span>
                        {test.result.reason}
                      </p>
                    ))}
                  {test.state === 'error' && (
                    <p className={styles.result}>
                      <span className={styles.bad}>✕ 시험 못 함</span>
                      {test.message}
                    </p>
                  )}

                  <div className={styles.btns}>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={args.trim() === opts.defaultArgs}
                      onClick={() => {
                        setArgs(opts.defaultArgs)
                        setTest({ state: 'idle' })
                      }}
                    >
                      기본값으로 되돌리기
                    </Button>
                    <Button
                      size="sm"
                      disabled={!choice?.downloaded || test.state === 'running' || !args.trim()}
                      title={choice?.downloaded ? undefined : '이 모델을 받은 뒤 시험할 수 있어요'}
                      onClick={() => void runTest()}
                    >
                      {test.state === 'running' ? '시험하는 중…' : '샘플로 시험하기'}
                    </Button>
                    <Button size="sm" variant="primary" disabled={!dirty || saving || !args.trim()} onClick={() => void save()}>
                      저장
                    </Button>
                  </div>
                </>
              )}
            </Block>

            <Block title="요약 세부설정">
              {!steps ? (
                <p className={styles.hint}>불러오는 중…</p>
              ) : (
                <>
                  <Select
                    label="교정 검증 모델"
                    value={steps.verifyModel}
                    disabled={!connected}
                    onChange={(e) => void saveSteps({ verifyModel: e.target.value })}
                    hint="요약이 찾은 받아쓰기 교정을 이 모델이 전사의 앞뒤 문맥과 함께 한 번 더 확인해, 틀리거나 표기만 바꾸는 교정을 걸러요. 크레딧은 90분 강의 기준(어림)이에요."
                  >
                    {steps.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                        {m.id === steps.defaultModel ? ' (기본)' : ''} · {creditsLabel(m.verify90)}
                      </option>
                    ))}
                  </Select>

                  <RadioCardGroup
                    label="전사문 다듬기"
                    value={steps.polishModel ? 'api' : 'off'}
                    onChange={(v) => void saveSteps({ polishModel: v === 'api' ? polishModel : null })}
                    options={[
                      { value: 'off', title: '사용 안 함', description: '받아쓴 전사에 요약이 찾은 교정만 적용해요.', disabled: !connected },
                      {
                        value: 'api',
                        title: '요약 서비스로 다듬기',
                        description: '요약 서비스가 전사 전체를 읽고 잘못 받아쓴 말을 고쳐 다시 써요.',
                        meta: creditsLabel(polish90),
                        disabled: !connected
                      },
                      { value: 'local', title: '로컬 LLM으로 다듬기', description: 'Ollama가 이 PC에서 다듬어요. 크레딧이 들지 않아요.', meta: '곧 지원', disabled: true }
                    ]}
                  />
                  {steps.polishModel && (
                    <Select
                      label="다듬기 모델"
                      value={steps.polishModel}
                      disabled={!connected}
                      onChange={(e) => {
                        setPolishPick(e.target.value)
                        void saveSteps({ polishModel: e.target.value })
                      }}
                    >
                      {steps.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                          {m.id === steps.defaultModel ? ' (기본)' : ''} · {creditsLabel(m.polish90)}
                        </option>
                      ))}
                    </Select>
                  )}
                  <p className={styles.hint}>
                    다듬기를 켜면 90분 강의에 위 크레딧이 더 들고 1~2분 더 걸려요. 모델이 하지 않은 말을 넣거나 빼는 경우가 있어, 원래 받아쓰기는 노트의 원문 정리본에 그대로
                    남겨요. 다듬은 전사에는 교정 검증을 하지 않아요.
                    {!connected && ' 요약 서비스를 연결하면 바꿀 수 있어요.'}
                  </p>
                </>
              )}
            </Block>

            <Block title="로컬 LLM (Ollama)">
              <RadioCardGroup
                label="로컬 LLM"
                value="off"
                onChange={() => {}}
                options={[
                  { value: 'off', title: '사용 안 함', description: '요약은 요약 서비스(ChatKHU)가 해요.' },
                  {
                    value: 'pre',
                    title: '로컬 전처리',
                    description: '받아쓴 전사를 Ollama가 먼저 교정하고, 요약은 요약 서비스가 해요.',
                    meta: '곧 지원',
                    disabled: true
                  },
                  {
                    value: 'local',
                    title: '완전 로컬',
                    description: '교정과 요약 모두 Ollama가 해요. 키가 없어도 되고 녹음 내용이 PC 밖으로 나가지 않아요.',
                    meta: '곧 지원',
                    disabled: true
                  }
                ]}
              />
              <p className={styles.hint}>Ollama를 설치하고 모델을 받아 두면 쓸 수 있게 할 예정이에요.</p>
            </Block>
          </div>
        )}
      </div>
    </Section>
  )
})
