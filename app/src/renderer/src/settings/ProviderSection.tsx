import { forwardRef, useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError, call } from '../api'
import { Button, Dialog, RadioCardGroup, Select, TextField, useToast } from '../components'
import type { LlmStatus } from '../wizard/shared'
import { Block, Row, Section, SettingsCard } from './parts'
import styles from './Settings.module.css'

type Provider = { id: string; name: string; available: boolean }
type Models = { selected: string; recommended: string; failed: boolean; models: { id: string; credits90: number | null }[] }

const DESCRIPTIONS: Record<string, string> = { chatkhu: '경희대 ChatKHU 크레딧으로 요약해요.' }

function keyError(e: unknown): string {
  const code = e instanceof ApiError ? e.code : 'unknown'
  if (code === 'auth') return '키가 올바르지 않아요. 앞뒤 공백 없이 다시 붙여 넣어 주세요.'
  if (code === 'network') return '인터넷 연결을 확인해 주세요.'
  return (e as Error).message
}

type Props = {
  llm: LlmStatus | null
  /** 홈의 [연결하기]·작업 목록의 [키 다시 넣기]로 들어오면 바뀐다: 키 입력칸을 열고 초점을 둔다 */
  openKey: number
  /** 연결하거나 끊으면 사이드바의 크레딧을 다시 불러온다 */
  onChange: () => void
}

// 요약 서비스: 연결 상태, [키 바꾸기] [연결 끊기], 서비스 목록(ChatKHU 외에는 곧 지원), 요약 모델.
export const ProviderSection = forwardRef<HTMLElement, Props>(function ProviderSection({ llm, openKey, onChange }, ref) {
  const toast = useToast()
  const [providers, setProviders] = useState<Provider[]>([])
  const [selected, setSelected] = useState('chatkhu')
  const [editing, setEditing] = useState(false)
  const [key, setKey] = useState('')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<Models | null>(null)
  const [confirmOff, setConfirmOff] = useState(false)
  const keyInput = useRef<HTMLInputElement>(null)

  const connected = !!llm?.provider
  const formOpen = editing || (llm !== null && !connected)
  const name = providers.find((p) => p.id === selected)?.name ?? ''

  useEffect(() => {
    call<Provider[]>('llm.providers').then(setProviders)
  }, [])

  // 연결이 바뀌면 모델 목록을 다시 불러온다
  useEffect(() => {
    if (connected) call<Models>('llm.models').then(setModels, () => setModels(null))
    else setModels(null)
  }, [connected, llm?.keyHint])

  const wantFocus = useRef(false)
  useEffect(() => {
    if (!openKey) return
    wantFocus.current = true
    setEditing(true)
  }, [openKey])
  // 키 입력칸이 그려진 뒤에 초점을 둔다 (연결된 상태면 setEditing 다음 렌더에서 칸이 생긴다)
  useEffect(() => {
    if (wantFocus.current && keyInput.current) {
      wantFocus.current = false
      keyInput.current.focus()
    }
  })

  function closeForm(): void {
    setEditing(false)
    setKey('')
    setError(null)
  }

  async function connect(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!key.trim()) return
    setChecking(true)
    setError(null)
    try {
      await call('llm.connect', { provider: selected, key })
      toast(`${name}와 연동했어요.`, 'success')
      closeForm()
      onChange()
    } catch (err) {
      setError(keyError(err))
    } finally {
      setChecking(false)
    }
  }

  async function disconnect(): Promise<void> {
    setConfirmOff(false)
    try {
      await call('llm.disconnect')
      toast('연결을 끊었어요. 이제 전사문만 담은 노트를 만들어요.', 'success')
      onChange()
    } catch (err) {
      toast((err as Error).message, 'danger')
    }
  }

  async function pickModel(id: string): Promise<void> {
    try {
      await call('llm.setModel', id)
      setModels((m) => (m ? { ...m, selected: id } : m))
      onChange() // 남은 요약 횟수가 모델마다 다르다
    } catch (err) {
      toast((err as Error).message, 'danger')
    }
  }

  const modelLabel = (m: Models['models'][number]): string =>
    [m.id, m.id === models?.recommended ? '권장' : null, m.credits90 != null ? `요약 1회 약 ${Math.round(m.credits90)}크레딧` : null]
      .filter(Boolean)
      .join(' · ')

  return (
    <Section ref={ref} title="요약 서비스">
      <SettingsCard>
        {llm === null ? (
          <Row title="불러오는 중…" />
        ) : connected ? (
          <Row
            title={`${llm.name}와 연동되어 있어요`}
            sub={[
              `키 ••••${llm.keyHint}`,
              llm.credits != null ? `남은 크레딧 ${llm.credits.toLocaleString()}` : null,
              llm.summariesLeft != null ? `이번 달 약 ${llm.summariesLeft.toLocaleString()}개` : null
            ]
              .filter(Boolean)
              .join(' · ')}
            ctrl={
              !editing && (
                <>
                  <Button size="sm" onClick={() => setEditing(true)}>
                    키 바꾸기
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmOff(true)}>
                    연결 끊기
                  </Button>
                </>
              )
            }
          />
        ) : (
          <Row title="연결된 요약 서비스가 없어요" sub="전사문만 담은 노트를 만들어요. 연결하면 요약과 주요 키워드까지 만들어요." />
        )}

        {formOpen && (
          <Block>
            <RadioCardGroup
              label="요약 서비스"
              columns={2}
              value={selected}
              onChange={(v) => {
                setSelected(v)
                setError(null)
              }}
              options={providers.map((p) => ({
                value: p.id,
                title: p.name,
                description: DESCRIPTIONS[p.id],
                meta: p.available ? undefined : '곧 지원',
                disabled: !p.available
              }))}
            />
            <form className={styles.form} onSubmit={(e) => void connect(e)}>
              <div className={styles.grow}>
                <TextField
                  ref={keyInput}
                  label={`${name} 키`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="키를 붙여 넣어 주세요"
                  value={key}
                  error={error ?? undefined}
                  onChange={(e) => {
                    setKey(e.target.value)
                    setError(null)
                  }}
                />
              </div>
              <Button type="submit" disabled={!key.trim() || checking}>
                {checking ? '확인 중…' : '확인'}
              </Button>
              {connected && (
                <Button variant="ghost" onClick={closeForm}>
                  취소
                </Button>
              )}
            </form>
            <p className={styles.hint}>
              키는 이 PC에만 암호화해서 저장돼요.{' '}
              <Button variant="link" onClick={() => void call('llm.openKeyGuide', selected)}>
                키 발급 방법 보기
              </Button>
            </p>
          </Block>
        )}

        <Block>
          <Select
            label="요약 모델"
            disabled={!connected || !models}
            value={models?.selected ?? ''}
            onChange={(e) => void pickModel(e.target.value)}
            hint={
              !connected
                ? '요약 서비스를 연결하면 고를 수 있어요.'
                : models?.failed
                  ? '모델 목록을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.'
                  : '모델마다 크레딧과 요약 품질이 달라요. 처음 쓰는 모델의 크레딧은 한 번 써 본 뒤 알려 드려요.'
            }
          >
            {!models && <option value="">{connected ? '불러오는 중…' : '연결된 서비스 없음'}</option>}
            {models?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {modelLabel(m)}
              </option>
            ))}
          </Select>
        </Block>
      </SettingsCard>

      <Dialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title="요약 서비스 연결을 끊을까요?"
        actions={
          <>
            <Button onClick={() => setConfirmOff(false)}>취소</Button>
            <Button variant="danger" onClick={() => void disconnect()}>
              연결 끊기
            </Button>
          </>
        }
      >
        <p className={styles.dialogText}>이 PC에 저장한 키를 지워요. 다시 연결하려면 키를 새로 붙여 넣어야 해요. 이미 만든 노트는 그대로예요.</p>
      </Dialog>
    </Section>
  )
})
