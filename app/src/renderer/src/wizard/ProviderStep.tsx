import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, call } from '../api'
import { Banner, Button, RadioCardGroup, TextField } from '../components'
import type { LlmStatus, StepProps } from './shared'
import { KeyGuideLink } from './KeyGuide'
import { Step } from './Step'
import styles from './Wizard.module.css'

type Provider = { id: string; name: string; available: boolean }
type Connected = { keyHint: string; credits: number | null; summariesLeft: number | null }
type Check = { state: 'idle' | 'checking' } | { state: 'ok'; result: Connected } | { state: 'error'; message: string }

const DESCRIPTIONS: Record<string, string> = {
  chatkhu: '경희대 ChatKHU 크레딧으로 요약해요.',
  openai: 'OpenAI API 키로 요약해요. 쓴 만큼 OpenAI에 요금을 내요.',
  claude: 'Claude API 키로 요약해요. 쓴 만큼 Anthropic에 요금을 내요.',
  gemini: 'Gemini API 키로 요약해요. 무료 등급은 보낸 내용이 모델 개선에 쓰일 수 있어요.'
}

function errorMessage(e: unknown): string {
  const code = e instanceof ApiError ? e.code : 'unknown'
  if (code === 'auth') return '키가 올바르지 않아요. 앞뒤 공백 없이 다시 붙여 넣어 주세요.'
  if (code === 'network') return '인터넷 연결을 확인해 주세요. 키는 나중에 설정에서 넣어도 돼요.'
  return (e as Error).message
}

// 요약 서비스는 지금 ChatKHU만 되고, 나머지는 "곧 지원"으로 흐리게 보인다.
export function ProviderStep({ next, back, headingRef }: StepProps): React.JSX.Element {
  const [providers, setProviders] = useState<Provider[]>([])
  const [selected, setSelected] = useState('chatkhu')
  const [status, setStatus] = useState<LlmStatus | null>(null)
  const [key, setKey] = useState('')
  const [check, setCheck] = useState<Check>({ state: 'idle' })

  useEffect(() => {
    call<Provider[]>('llm.providers').then(setProviders)
    call<LlmStatus>('llm.status').then((s) => {
      setStatus(s)
      if (s.provider) setSelected(s.provider)
    })
  }, [])

  const name = providers.find((p) => p.id === selected)?.name ?? ''
  const alreadyConnected = status?.provider === selected && !key
  const connected = check.state === 'ok' || alreadyConnected
  // 키가 없고 아직 붙여 넣지도 않았으면 [다음] 대신 [키 발급 방법 보기]가 주 버튼이다
  const needsKey = !connected && !key.trim()

  async function verify(): Promise<boolean> {
    setCheck({ state: 'checking' })
    try {
      const result = await call<Connected>('llm.connect', { provider: selected, key })
      setCheck({ state: 'ok', result })
      return true
    } catch (e) {
      setCheck({ state: 'error', message: errorMessage(e) })
      return false
    }
  }

  function onSubmit(e: FormEvent): void {
    e.preventDefault()
    if (key.trim()) void verify()
  }

  async function onNext(): Promise<void> {
    if (check.state === 'ok' || alreadyConnected) next()
    else if (await verify()) next()
  }

  return (
    <Step
      title="요약에 쓸 서비스를 연결해 주세요"
      description={
        <>
          키는 {name || '요약 서비스'}가 이 앱에 요약을 허락하는 암호예요. 이 PC에만 암호화해서 저장되고, 요약할 때만 {name || '요약 서비스'}로 보내요.
          {!needsKey && (
            <>
              {' '}
              <KeyGuideLink provider={selected} />
            </>
          )}
        </>
      }
      headingRef={headingRef}
      actions={
        <>
          <Button variant="ghost" className={styles.back} onClick={back}>
            이전
          </Button>
          {!connected && (
            <Button variant="ghost" onClick={next}>
              요약 없이 계속
            </Button>
          )}
          {needsKey ? (
            <KeyGuideLink provider={selected} primary />
          ) : (
            <Button variant="primary" size="lg" disabled={check.state === 'checking'} onClick={() => void onNext()}>
              다음
            </Button>
          )}
        </>
      }
    >
      <RadioCardGroup
        label="요약 서비스"
        columns={2}
        value={selected}
        onChange={(v) => {
          setSelected(v)
          setCheck({ state: 'idle' })
        }}
        options={providers.map((p) => ({
          value: p.id,
          title: p.name,
          description: DESCRIPTIONS[p.id],
          meta: p.available ? undefined : '곧 지원',
          disabled: !p.available
        }))}
      />

      <form className={styles.row} onSubmit={onSubmit}>
        <div className={styles.grow}>
          <TextField
            label={`${name} 키`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={alreadyConnected ? `저장된 키 ••••${status?.keyHint}` : '키를 붙여 넣어 주세요'}
            value={key}
            onChange={(e) => {
              setKey(e.target.value)
              setCheck({ state: 'idle' })
            }}
          />
        </div>
        <Button type="submit" disabled={!key.trim() || check.state === 'checking'}>
          {check.state === 'checking' ? '확인 중…' : '확인'}
        </Button>
      </form>

      {check.state === 'ok' && (
        <Banner tone="success" title="확인됐어요.">
          {check.result.credits !== null &&
            `이번 달 남은 크레딧 ${check.result.credits.toLocaleString()} · 90분 강의 약 ${check.result.summariesLeft?.toLocaleString()}개를 요약할 수 있어요.`}
        </Banner>
      )}
      {check.state === 'error' && <Banner tone="danger">{check.message}</Banner>}
      {alreadyConnected && check.state === 'idle' && (
        <Banner tone="success">
          {name}와 연동되어 있어요 · 키 ••••{status?.keyHint}
          {status?.credits != null && ` · 남은 크레딧 ${status.credits.toLocaleString()}`}
        </Banner>
      )}

      {!connected && <p className={styles.small}>키 없이도 전사문 노트는 만들 수 있어요. 요약은 키를 넣은 뒤부터 만들어져요.</p>}
    </Step>
  )
}
