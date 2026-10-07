import { forwardRef, useEffect, useRef, useState } from 'react'
import { ApiError, call } from '../api'
import { Button, Dialog, RadioCardGroup, Switch, TextField, useToast } from '../components'
import type { Settings } from '../../../core/settings'
import { cx } from '../components/cx'
import { ModelPicker, type ModelOption } from './ModelPicker'
import { OllamaBlock } from './OllamaBlock'
import { SummaryPrompt } from './SummaryPrompt'
import type { SetupState } from '../../../main/setup'
import { Block, Section, sizeLabel } from './parts'
import styles from './Settings.module.css'
import { GPU, GPU_PC_ADVICE, PC, PC_SUBJ } from '../platform'

type Choice = { id: string; size: number; downloaded: boolean; deletable: boolean; locked: string }
// defaultArgs는 속도를 재기 전이면 null(쓸 장치를 아직 모름), args는 고쳐 저장한 옵션이 없으면 null
type Options = { model: string; choices: Choice[]; defaultArgs: string | null; args: string | null }
type SampleTest = { sampleS: number; processS: number; chars: number; ok: boolean; reason?: string }

const MODEL_TEXT: Record<string, { title: string; description: (gpu: boolean) => string }> = {
  'large-v3-turbo-q8_0': { title: '기본 · large-v3-turbo-q8_0', description: () => `대부분의 ${PC}에 맞아요. 속도와 정확도의 균형.` },
  'large-v3-q5_0': {
    title: '더 정확하게 · large-v3',
    description: (gpu) => (gpu ? `${GPU_PC_ADVICE} 기본보다 약 2배 느려요.`.trim() : `${GPU}가 없는 이 ${PC}에서는 아주 느려요.`)
  },
  'small-q5_1': { title: '가볍게 · small', description: () => `느린 ${PC}용. 정확도가 낮아요.` }
}

type Props = {
  setup: SetupState | null
  /** 요약 서비스가 연결돼 있어야 요약 세부설정을 바꿀 수 있다 */
  connected: boolean
  /** 받은 모델의 크기 (저장 공간에서 모델을 지우면 모델 선택을 다시 불러온다) */
  modelsBytes: number
  /** 받아쓰기 모델을 바꾸거나 지우면 저장 공간 크기가 바뀐다 */
  onSaved: () => void
  /** 요약 세부설정을 바꾸면 남은 요약 횟수가 바뀐다 */
  onStepsSaved: () => void
}

type Steps = {
  polishModel: string | null
  /** 단계를 로컬 LLM으로 하는지와, 로컬 LLM 블록에서 고른 모델 */
  local: { summary: boolean; polish: boolean; summaryModel: string | null; polishModel: string | null }
  /** 연결된 요약 서비스 이름과, 크레딧으로 쓰는 서비스인지 */
  service: string
  credits: boolean
  defaultModel: string
  failed: boolean
  available: string[]
  models: ModelOption[]
}

const LOCAL_PICK_FIRST = '아래 로컬 LLM에서 모델을 먼저 골라요'

/** "약 0.4크레딧", 모르면 "크레딧 모름" */
function creditsLabel(v: number | null): string {
  return v == null ? '크레딧 모름' : `약 ${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)}크레딧`
}

// 고급(기본은 접힘): 받아쓰기 세부설정(모델, 실제 명령, 고칠 수 있는 옵션, 샘플로 시험), 요약 세부설정(요약·전사문 다듬기를 요약 서비스로 할지 로컬 LLM으로 할지), 로컬 LLM(OllamaBlock), 실험 기능(ChatKHU 받아쓰기, 녹음 중 받아쓰기).
export const AdvancedSection = forwardRef<HTMLElement, Props>(function AdvancedSection({ setup, connected, modelsBytes, onSaved, onStepsSaved }, ref) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [steps, setSteps] = useState<Steps | null>(null)
  // 다듬기를 켤 때 고를 모델 (끈 동안에도 마지막으로 고른 모델을 기억)
  const [polishPick, setPolishPick] = useState<string | null>(null)

  // 실험 기능: 켜고 끄면 바로 저장한다
  const [exp, setExp] = useState<Pick<Settings, 'sttWhileRecording' | 'chatkhuStt'> | null>(null)

  useEffect(() => {
    if (!open) return
    call<Steps>('llm.steps').then(setSteps)
    call<Settings>('settings.get').then((s) => setExp({ sttWhileRecording: s.sttWhileRecording, chatkhuStt: s.chatkhuStt }))
  }, [open])

  async function saveExp(key: keyof NonNullable<typeof exp>, on: boolean): Promise<void> {
    const method = key === 'chatkhuStt' ? 'settings.setChatkhuStt' : 'settings.setSttWhileRecording'
    setExp((e) => e && { ...e, [key]: on })
    try {
      const saved = await call<boolean>(method, on)
      setExp((e) => e && { ...e, [key]: saved })
    } catch (err) {
      setExp((e) => e && { ...e, [key]: !on })
      toast(err instanceof ApiError ? err.message : '저장하지 못했어요.', 'danger')
    }
  }

  async function saveSteps(patch: { polishModel?: string | null; summaryLocal?: boolean; polishLocal?: boolean }): Promise<void> {
    try {
      await call('llm.setSteps', patch)
      setSteps(await call<Steps>('llm.steps'))
      onStepsSaved()
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '저장하지 못했어요.', 'danger')
    }
  }

  const polishModel = steps?.polishModel ?? polishPick ?? steps?.defaultModel ?? ''
  const polishVia = steps?.local.polish ? 'local' : steps?.polishModel ? 'api' : 'off'
  const polish90 = steps?.models.find((m) => m.id === polishModel)?.credits90 ?? null
  const [opts, setOpts] = useState<Options | null>(null)
  const [model, setModel] = useState('')
  // 옵션 입력칸에 쓴 글. null이면 손대지 않은 것: 기본 옵션을 보이고, 저장해도 고친 옵션으로 남기지 않는다.
  const [args, setArgs] = useState<string | null>(null)
  const [test, setTest] = useState<{ state: 'idle' | 'running' } | { state: 'done'; result: SampleTest } | { state: 'error'; message: string }>({
    state: 'idle'
  })
  const [saving, setSaving] = useState(false)
  // 지울지 묻는 모델
  const [deleting, setDeleting] = useState<Choice | null>(null)

  // 펼칠 때와, 속도를 다시 재서 기본 옵션(장치·스레드)이 바뀌었을 때, 받은 모델이 바뀌었을 때 불러온다
  const probeKey = `${setup?.name}:${setup?.probe.state}:${setup?.probe.gpuDevice}:${setup?.model.state}:${modelsBytes}`
  // 저장된 고친 옵션은 처음 불러올 때만 입력칸에 넣는다 (다시 불러올 때 넣으면 쓰던 글이 바뀐다)
  const loaded = useRef(false)
  useEffect(() => {
    if (!open) return
    call<Options>('stt.options').then((o) => {
      setOpts(o)
      setModel((m) => m || o.model)
      if (!loaded.current) setArgs(o.args)
      loaded.current = true
    })
  }, [open, probeKey])

  const choice = opts?.choices.find((c) => c.id === model)
  // 그래픽카드 없이 받아쓰는 PC에서는 large-v3를 고를 수 없다 (아주 느림)
  const gpu = setup?.probe.state !== 'done' || !!setup.probe.gpuName
  // 입력칸에 보이는 옵션: 손대지 않았으면 기본 옵션 (속도를 재기 전이면 아직 없음)
  const shown = args ?? opts?.defaultArgs ?? ''
  // 저장할 고친 옵션: 손대지 않았거나 기본 옵션과 같으면 없음
  const custom = args === null || args.trim() === opts?.defaultArgs ? null : args.trim()
  const dirty = !!opts && (model !== opts.model || custom !== opts.args)

  async function runTest(): Promise<void> {
    setTest({ state: 'running' })
    try {
      setTest({ state: 'done', result: await call<SampleTest>('stt.test', { model, args: shown }) })
    } catch (e) {
      setTest({ state: 'error', message: e instanceof ApiError ? e.message : '시험하지 못했어요.' })
    }
  }

  async function deleteModel(): Promise<void> {
    const target = deleting
    setDeleting(null)
    if (!target) return
    try {
      await call('models.delete', target.id)
      setOpts(await call<Options>('stt.options'))
      setTest({ state: 'idle' })
      toast(`${target.id} 모델을 지웠어요.`, 'success')
      onSaved()
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '지우지 못했어요.', 'danger')
    }
  }

  async function save(): Promise<void> {
    setSaving(true)
    try {
      const o = await call<Options>('stt.save', { model, args: custom })
      setOpts(o)
      setModel(o.model)
      setArgs(o.args)
      toast(o.choices.find((c) => c.id === o.model)?.downloaded ? '받아쓰기 설정을 저장했어요.' : `저장했어요. 모델을 받은 뒤 이 ${PC}의 속도를 다시 재요.`, 'success')
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
          <span>받아쓰기 세부설정 · 요약 세부설정 · 로컬 LLM · 실험 기능</span>
        </button>
        {open && (
          <div className={styles.advBody}>
            <Block title="받아쓰기 세부설정" foldable>
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
                      meta: (
                        <>
                          {sizeLabel(c.size)} · {c.downloaded ? '받음' : '받아야 해요'}
                          {c.deletable && (
                            <>
                              {' · '}
                              <Button variant="link" onClick={() => setDeleting(c)}>
                                지우기
                              </Button>
                            </>
                          )}
                        </>
                      ),
                      disabled: c.id === 'large-v3-q5_0' && !gpu && opts.model !== c.id
                    }))}
                  />
                  <p className={styles.hint}>모델을 바꾸면 받은 뒤 이 {PC}의 속도를 다시 재고, 예상 시간도 바뀌어요.</p>
                  <Dialog
                    open={!!deleting}
                    onClose={() => setDeleting(null)}
                    title={`${deleting?.id} 모델을 지울까요?`}
                    actions={
                      <>
                        <Button onClick={() => setDeleting(null)}>취소</Button>
                        <Button variant="danger" onClick={() => void deleteModel()}>
                          지우기
                        </Button>
                      </>
                    }
                  >
                    <p className={styles.dialogText}>다시 쓰려면 다시 받아야 해요. 지금 쓰는 모델은 그대로예요.</p>
                  </Dialog>

                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>실제로 부르는 명령</span>
                    <p className={styles.code}>
                      {choice?.locked} <mark>{shown.trim()}</mark>
                    </p>
                  </div>
                  <p className={styles.hint}>색칠된 옵션만 고칠 수 있어요. 파일·모델·언어·출력 형식은 앱이 정해요(강의 언어는 과목에서).</p>

                  <TextField
                    label="고칠 수 있는 옵션"
                    className={styles.mono}
                    spellCheck={false}
                    autoComplete="off"
                    hint={args === null && opts.defaultArgs === null ? `이 ${PC}의 속도를 잰 뒤 기본 옵션이 정해져요. ${GPU}를 쓸지는 재 봐야 알아요.` : undefined}
                    value={shown}
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
                      disabled={custom === null}
                      onClick={() => {
                        setArgs(null)
                        setTest({ state: 'idle' })
                      }}
                    >
                      기본값으로 되돌리기
                    </Button>
                    <Button
                      size="sm"
                      disabled={!choice?.downloaded || test.state === 'running' || !shown.trim()}
                      title={choice?.downloaded ? undefined : '이 모델을 받은 뒤 시험할 수 있어요'}
                      onClick={() => void runTest()}
                    >
                      {test.state === 'running' ? '시험하는 중…' : '샘플로 시험하기'}
                    </Button>
                    <Button size="sm" variant="primary" disabled={!dirty || saving || (args !== null && !args.trim())} onClick={() => void save()}>
                      저장
                    </Button>
                  </div>
                </>
              )}
            </Block>

            <Block title="요약 세부설정" foldable>
              {!steps ? (
                <p className={styles.hint}>불러오는 중…</p>
              ) : (
                <>
                  <RadioCardGroup
                    label="요약"
                    value={steps.local.summary ? 'local' : 'api'}
                    onChange={(v) => void saveSteps({ summaryLocal: v === 'local' })}
                    options={[
                      {
                        value: 'api',
                        title: '요약 서비스로 요약',
                        description: '연결한 요약 서비스가 요약해요. 모델은 위의 요약 서비스에서 골라요.',
                        meta: connected ? undefined : '연결 안 됨 · 요약 없이 전사문만'
                      },
                      {
                        value: 'local',
                        title: '로컬 LLM으로 요약',
                        description: `Ollama가 이 ${PC}에서 요약해요. 키가 없어도 되고 크레딧이 들지 않아요.`,
                        meta: steps.local.summaryModel ?? LOCAL_PICK_FIRST,
                        disabled: !steps.local.summaryModel
                      }
                    ]}
                  />
                  <RadioCardGroup
                    label="전사문 다듬기"
                    value={polishVia}
                    onChange={(v) =>
                      void saveSteps(v === 'local' ? { polishLocal: true } : { polishModel: v === 'api' ? polishModel : null, polishLocal: false })
                    }
                    options={[
                      { value: 'off', title: '전사문 다듬기 안 함', description: '받아쓴 전사에 요약이 찾은 교정만 적용해요.' },
                      {
                        value: 'api',
                        title: '요약 서비스로 다듬기',
                        description: '요약 서비스가 전사 전체를 읽고 잘못 받아쓴 말을 고쳐 다시 써요.',
                        meta: steps.credits ? creditsLabel(polish90) : undefined,
                        disabled: !connected
                      },
                      {
                        value: 'local',
                        title: '로컬 LLM으로 다듬기',
                        description: `Ollama가 이 ${PC}에서 다듬어요. 크레딧이 들지 않아요.`,
                        meta: steps.local.polishModel ?? LOCAL_PICK_FIRST,
                        disabled: !steps.local.polishModel
                      }
                    ]}
                  />
                  {polishVia === 'api' && steps.polishModel && (
                    <ModelPicker
                      kind="polish"
                      service={steps.service}
                      credits={steps.credits}
                      models={steps.models}
                      selected={steps.polishModel}
                      available={steps.available}
                      disabled={!connected}
                      failed={steps.failed}
                      onPick={(id) => {
                        setPolishPick(id)
                        void saveSteps({ polishModel: id })
                      }}
                    />
                  )}
                  <p className={styles.hint}>
                    전사문의 잘못 받아쓴 말, 특히 전문용어를 고쳐서 읽기 좋게 해요. 요약은 거의 달라지지 않아요. 요약 서비스로 다듬으면 90분 강의에 {steps.credits ? '위 크레딧이' : '요약의 몇 배만큼 토큰이'} 더 들고 1~2분 더 걸려요. 모델이 하지 않은 말을 넣거나 빼는 경우가 있어, 원래 받아쓰기는 노트의 원문 정리본에
                    그대로 남겨요. 크레딧은 90분 강의 기준(어림)이고, 정확하지 않아요.
                    {!connected && ' 요약 서비스로 다듬기는 요약 서비스를 연결하면 고를 수 있어요.'}
                  </p>
                </>
              )}
              <SummaryPrompt />
            </Block>

            <OllamaBlock
              onSaved={() => {
                call<Steps>('llm.steps').then(setSteps)
                onStepsSaved()
              }}
            />

            <Block title="실험 기능" foldable>
              <div className={styles.switches}>
                <Switch
                  checked={!!exp?.chatkhuStt}
                  disabled={!exp || (!connected && !exp.chatkhuStt)}
                  onChange={(on) => void saveExp('chatkhuStt', on)}
                  label="받아쓰기(Speech-to-Text)에 ChatKHU Soniox 모델 쓰기"
                  hint={
                    <>
                      이 {PC}의 whisper 대신 ChatKHU가 받아써요. 전문 용어를 훨씬 정확히 받아쓰지만 오디오 1분에 6크레딧(90분 강의 약 540)이 들고,
                      녹음이 ChatKHU로 보내져요. 말한 그대로 적어서 "어", "네" 같은 말도 들어가요.
                      {!connected && ' ChatKHU를 연결하면 켤 수 있어요.'}
                    </>
                  }
                />
                <Switch
                  checked={!!exp?.sttWhileRecording}
                  disabled={!exp}
                  onChange={(on) => void saveExp('sttWhileRecording', on)}
                  label="녹음하는 동안에도 받아쓰기"
                  hint={`끄면(기본) 앱에서 녹음하는 동안 앞서 넣은 녹음의 받아쓰기를 멈추고, 녹음이 끝나면 멈춘 곳부터 이어서 해요. 켜면 둘이 함께 돌아 ${PC_SUBJ} 느려질 수 있어요.`}
                />
              </div>
            </Block>
          </div>
        )}
      </div>
    </Section>
  )
})
