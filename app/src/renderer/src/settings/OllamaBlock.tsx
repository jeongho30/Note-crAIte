import { useEffect, useState } from 'react'
import { ApiError, call } from '../api'
import { Button, Select, TextField, useToast } from '../components'
import { Block, sizeLabel } from './parts'
import styles from './Settings.module.css'

type Model = { id: string; bytes: number; parameters: string | null; quantization: string | null; contextLength: number | null }
type Step = { model: string | null; request: string; defaultRequest: string }
type State = { running: boolean; version: string | null; endpoint: string; models: Model[]; summary: Step; polish: Step; autoCtx90: number }
type TestResult = { chars: number; loadS: number; tokensPerS: number | null; numCtx: number | null }
type Test = { state: 'idle' | 'running' } | { state: 'done'; result: TestResult } | { state: 'error'; message: string }

const STEP_TEXT = { polish: '전사문 다듬기', summary: '요약' } as const

type FormProps = {
  name: 'polish' | 'summary'
  state: State
  /** 저장한 뒤의 상태를 올려 준다 */
  onSaved: (s: State) => void
}

// 단계 하나(다듬기 또는 요약)의 모델과 요청 옵션. 받아쓰기 세부설정처럼 실제 요청을 보여 주고 색칠된 부분만 고친다.
function StepForm({ name, state, onSaved }: FormProps): React.JSX.Element {
  const toast = useToast()
  const saved = state[name]
  const [model, setModel] = useState(saved.model ?? '')
  const [request, setRequest] = useState(saved.request)
  const [test, setTest] = useState<Test>({ state: 'idle' })
  const [saving, setSaving] = useState(false)

  const dirty = model !== (saved.model ?? '') || request.trim() !== saved.request
  const picked = state.models.find((m) => m.id === model)
  // 고칠 수 있는 부분은 바깥 중괄호를 떼고 앱이 정하는 키 뒤에 이어 보여 준다
  const editable = request.trim().replace(/^\{/, '').replace(/\}$/, '').trim()

  async function runTest(): Promise<void> {
    setTest({ state: 'running' })
    try {
      setTest({ state: 'done', result: await call<TestResult>('ollama.test', { step: name, model, request }) })
    } catch (e) {
      setTest({ state: 'error', message: e instanceof ApiError ? e.message : '시험하지 못했어요.' })
    }
  }

  async function save(): Promise<void> {
    setSaving(true)
    try {
      const next = await call<State>('ollama.save', { [`${name}Model`]: model, [`${name}Request`]: request })
      setRequest(next[name].request)
      onSaved(next)
      toast(`로컬 LLM ${STEP_TEXT[name]} 설정을 저장했어요.`, 'success')
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '저장하지 못했어요.', 'danger')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Select
        label={`${STEP_TEXT[name]} 모델`}
        value={model}
        onChange={(e) => {
          setModel(e.target.value)
          setTest({ state: 'idle' })
        }}
      >
        <option value="">모델 고르기</option>
        {model && !picked && <option value={model}>{model} · Ollama에 없음</option>}
        {state.models.map((m) => (
          <option key={m.id} value={m.id}>
            {[m.id, [m.parameters, m.quantization].filter(Boolean).join(' '), sizeLabel(m.bytes), m.contextLength ? `최대 컨텍스트 ${m.contextLength.toLocaleString()}` : null]
              .filter(Boolean)
              .join(' · ')}
          </option>
        ))}
      </Select>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>실제로 보내는 요청</span>
        <p className={styles.code}>
          POST {state.endpoint} {'{'}"model": "{model || '고른 모델'}", "messages": […], "stream": true, "truncate": false,
          {name === 'summary' && ' "format": {요약 형식},'} <mark>{editable}</mark>
          {'}'}
        </p>
      </div>

      <TextField
        label="고칠 수 있는 옵션 (JSON)"
        className={styles.mono}
        spellCheck={false}
        autoComplete="off"
        value={request}
        onChange={(e) => {
          setRequest(e.target.value)
          setTest({ state: 'idle' })
        }}
      />
      <p className={styles.hint}>
        {name === 'summary'
          ? `num_ctx "auto"는 전사 길이로 계산해요(90분 강의면 약 ${state.autoCtx90.toLocaleString()}). 숫자를 넣으면 그 값으로 고정돼요. `
          : '전사를 약 2000자씩 나눠 한 조각씩 보내요. '}
        입력이 num_ctx보다 길면 자르지 않고 작업을 멈춰요. 출력 상한은 num_predict로 바꿀 수 있어요(기본 {name === 'summary' ? '8192' : '4096'}). think를 받지 않는 모델에는
        think를 빼고 다시 보내요.
      </p>

      {test.state === 'running' && <p className={styles.result}>모델을 올려 불러 보는 중이에요…</p>}
      {test.state === 'done' && (
        <p className={styles.result}>
          <span className={styles.ok}>✓ 시험함</span>
          모델 올리기 {test.result.loadS.toFixed(1)}초
          {test.result.tokensPerS != null && ` · 초당 ${test.result.tokensPerS.toFixed(1)}토큰`}
          {test.result.numCtx != null && ` · num_ctx ${test.result.numCtx.toLocaleString()}`} · 답 {test.result.chars}자
        </p>
      )}
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
          disabled={request.trim() === saved.defaultRequest}
          onClick={() => {
            setRequest(saved.defaultRequest)
            setTest({ state: 'idle' })
          }}
        >
          기본값으로 되돌리기
        </Button>
        <Button size="sm" disabled={!state.running || !model || test.state === 'running' || !request.trim()} onClick={() => void runTest()}>
          {test.state === 'running' ? '시험하는 중…' : '시험하기'}
        </Button>
        <Button size="sm" variant="primary" disabled={!dirty || saving || !model || !request.trim()} onClick={() => void save()}>
          저장
        </Button>
      </div>
    </>
  )
}

// 설정 > 고급 > 로컬 LLM (Ollama): 연결 상태, 단계별 모델과 요청 옵션. 어느 단계를 로컬로 할지는 위의 요약 세부설정에서 고른다.
export function OllamaBlock({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const [state, setState] = useState<State | null>(null)
  const [checking, setChecking] = useState(false)

  async function load(): Promise<void> {
    setChecking(true)
    try {
      setState(await call<State>('ollama.get'))
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <Block title="로컬 LLM (Ollama)" foldable>
      {!state ? (
        <p className={styles.hint}>불러오는 중…</p>
      ) : (
        <>
          <p className={styles.result}>
            {state.running ? (
              <>
                <span className={styles.ok}>✓ Ollama {state.version} 켜져 있음</span>
                받아 둔 모델 {state.models.length}개
              </>
            ) : (
              <>
                <span className={styles.bad}>✕ Ollama에 연결하지 못했어요</span>
                Ollama를 켠 뒤 다시 확인해 주세요.
              </>
            )}
            <Button size="sm" variant="ghost" disabled={checking} onClick={() => void load()}>
              다시 확인
            </Button>
          </p>
          <p className={styles.hint}>
            이 PC의 Ollama({state.endpoint})를 불러요. 모델은 Ollama에서 미리 받아 두세요. 로컬 LLM으로 하는 단계는 크레딧이 들지 않고 그 내용이 PC 밖으로 나가지 않아요. 어느
            단계를 로컬로 할지는 위의 요약 세부설정에서 골라요.
          </p>
          {(['polish', 'summary'] as const).map((name) => (
            <Block key={name} title={STEP_TEXT[name]}>
              <StepForm
                // Ollama를 켠 뒤 다시 확인하면 모델 목록이 바뀐다
                key={`${state.running}:${state.models.length}`}
                name={name}
                state={state}
                onSaved={(s) => {
                  setState(s)
                  onSaved()
                }}
              />
            </Block>
          ))}
        </>
      )}
    </Block>
  )
}
