import { useState, type FormEvent } from 'react'
import { Button, Dialog, Select, TextField } from '../components'
import { cx } from '../components/cx'
import styles from './Settings.module.css'

export type ModelOption = {
  id: string
  owner: string | null
  /** 추천 순서(1부터). null이면 목록 밖 모델(새로 나온 모델, 직접 입력해 고른 모델) */
  rank: number | null
  /** 추천 순서를 정한 뒤에 서비스에 새로 나온 모델: [전체 모델 보기] 끝에 따로 보인다 */
  isNew?: boolean
  /** 앞쪽 추천 모델이면 true: 선택 칸의 "추천 모델 목록"에 보인다 */
  recommended: boolean
  note: string | null
  /** 90분 강의 요약 1회의 크레딧 */
  credits90: number | null
  /** measured: 써 본 기록, estimate: 단가표로 어림 */
  source: 'measured' | 'estimate' | null
}

const ALL = '\u0000all'
const CUSTOM = '\u0000custom'

/** "약 12크레딧", 10 미만은 소수 한 자리 */
function credits(m: ModelOption): string {
  if (m.credits90 == null) return '크레딧 모름'
  const v = m.credits90 < 10 ? Math.round(m.credits90 * 10) / 10 : Math.round(m.credits90)
  return `약 ${v}크레딧` /** '약'과 '어림'이 중복 의미라 (어림) 문구 삭제 */
}

const TEXT = {
  summary: {
    label: '요약 모델',
    credits: '크레딧은 90분 강의 요약 1회 기준 추정치에요. 단가표로 계산한 값이라 실제와 다를 수 있어요.',
    title: '요약 모델 고르기',
    intro: '강의 녹음으로 요약 품질·크레딧·받아쓰기 교정을 비교한 추천 순서예요. 크레딧은 90분 강의 요약 1회 기준 추정치이고, 단가표로 계산한 값이에요.',
    custom: '추천 목록 밖의 모델은 요약이 오래 걸려 실패할 수 있고, 실패해도 크레딧이 빠질 수 있어요.',
    fresh: '새로 나온 모델이에요. 아직 강의 녹음으로 비교해 보지 않아서, 요약이 오래 걸려 실패할 수 있고 실패해도 크레딧이 빠질 수 있어요.'
  },
  polish: {
    label: '다듬기 모델',
    credits: '크레딧은 90분 강의 다듬기 1회 기준으로 단가표로 계산한 값이라 실제와 다를 수 있어요.',
    title: '다듬기 모델 고르기',
    intro: '추천은 다듬기 크레딧이 적은 모델이고, 나머지는 요약 추천 순서예요. 다듬기 품질을 재 본 모델은 gpt-6-luna뿐이에요. 크레딧은 90분 강의 다듬기 1회 기준(어림)이고, 정확하지 않아요.',
    custom: '추천 목록 밖의 모델은 다듬기가 오래 걸려 실패할 수 있고, 실패해도 크레딧이 빠질 수 있어요.',
    fresh: '새로 나온 모델이에요. 아직 비교해 보지 않아서, 다듬기가 오래 걸려 실패할 수 있고 실패해도 크레딧이 빠질 수 있어요.'
  }
}

type Props = {
  /** 요약 모델(설정 > 요약 서비스) 또는 전사문 다듬기 모델(설정 > 고급). 기본은 요약 */
  kind?: keyof typeof TEXT
  models: ModelOption[] | null
  selected: string | null
  /** 서비스가 주는 글 모델 이름 전체. 비어 있으면(목록을 못 불러옴) 직접 입력한 이름을 확인하지 않는다 */
  available: string[]
  disabled: boolean
  /** 목록을 불러오지 못함 (인터넷 연결 등) */
  failed: boolean
  onPick: (id: string) => void
  /** 연결된 서비스 이름 (기본 ChatKHU) */
  service?: string
  /** 크레딧으로 쓰는 서비스인가. 아니면 추천 순서·크레딧 없이 서비스의 글 모델 목록만 보인다 (기본 true) */
  credits?: boolean
}

// 요약·다듬기 모델: 추천 모델 목록을 먼저 보이고, [전체 모델 보기] 창에서 추천 순서대로 고르거나, [직접 모델 입력]으로 이름을 넣는다.
export function ModelPicker({ kind = 'summary', models, selected, available, disabled, failed, onPick, service = 'ChatKHU', credits: billed = true }: Props): React.JSX.Element {
  const text = TEXT[kind]
  const [open, setOpen] = useState<'all' | 'custom' | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const current = models?.find((m) => m.id === selected) ?? null
  const recommended = (models ?? []).filter((m) => m.recommended)
  const ranked = (models ?? []).filter((m) => m.rank != null)
  const fresh = (models ?? []).filter((m) => m.isNew)

  const hint = disabled
    ? '요약 서비스를 연결하면 고를 수 있어요.'
    : failed
      ? '모델 목록을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.'
      : billed
        ? [current?.note, text.credits].filter(Boolean).join(' · ')
        : `${service}가 제공하는 글 모델이에요. 요금은 ${service}의 단가를 따르고, 작업 목록에는 쓴 토큰 수만 보여요.`
  const label = (m: ModelOption): string => (billed ? `${m.id} · ${credits(m)}` : m.id)

  function openCustom(): void {
    setName('')
    setError(null)
    setOpen('custom')
  }

  function submitCustom(e: FormEvent): void {
    e.preventDefault()
    const id = name.trim()
    if (!id) return
    if (available.length && !available.includes(id)) {
      setError(`${service}의 글 모델 목록에 없는 이름이에요. 대소문자까지 그대로 넣어 주세요.`)
      return
    }
    onPick(id)
    setOpen(null)
  }

  const row = (m: ModelOption): React.JSX.Element => (
    <button
      key={m.id}
      className={cx(styles.modelRow, m.id === selected && styles.modelRowOn)}
      aria-current={m.id === selected ? 'true' : undefined}
      onClick={() => {
        onPick(m.id)
        setOpen(null)
      }}
    >
      {billed && <span className={styles.modelRank}>{m.rank}</span>}
      <span className={styles.modelName}>
        {m.id}
        {m.recommended && <span className={styles.modelTag}>{billed ? '추천' : '기본'}</span>}
        {m.isNew && <span className={styles.modelTag}>새 모델</span>}
        {m.note && <span className={styles.modelNote}>{m.note}</span>}
      </span>
      {billed && <span className={styles.modelCredits}>{credits(m)}</span>}
    </button>
  )

  return (
    <>
      <Select
        label={text.label}
        disabled={disabled || !models}
        value={selected ?? ''}
        onChange={(e) => {
          if (e.target.value === ALL) setOpen('all')
          else if (e.target.value === CUSTOM) openCustom()
          else onPick(e.target.value)
        }}
        hint={hint}
      >
        {!models && <option value="">{disabled ? '연결된 서비스 없음' : '불러오는 중…'}</option>}
        {recommended.length > 0 && (
          <optgroup label={billed ? '추천 모델 목록' : '기본 모델'}>
            {recommended.map((m) => (
              <option key={m.id} value={m.id}>
                {label(m)}
              </option>
            ))}
          </optgroup>
        )}
        {current && !current.recommended && (
          <optgroup label="고른 모델">
            <option value={current.id}>{label(current)}</option>
          </optgroup>
        )}
        {ranked.length + fresh.length > recommended.length && <option value={ALL}>전체 모델 보기… ({ranked.length + fresh.length}개)</option>}
        {models && <option value={CUSTOM}>직접 모델 입력…</option>}
      </Select>

      <Dialog
        open={open === 'all'}
        size="lg"
        // [직접 모델 입력]으로 넘어갈 때 이 창이 닫히는 이벤트가 새 창을 닫지 않게
        onClose={() => setOpen((o) => (o === 'all' ? null : o))}
        title={text.title}
        actions={
          <>
            <Button variant="ghost" onClick={openCustom}>
              직접 모델 입력
            </Button>
            <Button onClick={() => setOpen(null)}>닫기</Button>
          </>
        }
      >
        <div className={styles.modelDialog}>
          <p className={styles.hint}>{billed ? text.intro : `${service}가 제공하는 글 모델 목록이에요. 강의 녹음으로 비교해 본 순서가 아니에요.`}</p>
          <div className={styles.modelList}>
            {ranked.map(row)}
          </div>
          {fresh.length > 0 && (
            <>
              <p className={styles.hint}>{text.fresh}</p>
              <div className={styles.modelList}>{fresh.map(row)}</div>
            </>
          )}
        </div>
      </Dialog>

      <Dialog
        open={open === 'custom'}
        onClose={() => setOpen((o) => (o === 'custom' ? null : o))}
        title="직접 모델 입력"
        actions={
          <>
            <Button onClick={() => setOpen(null)}>취소</Button>
            <Button variant="primary" type="submit" form="custom-model" disabled={!name.trim()}>
              이 모델 쓰기
            </Button>
          </>
        }
      >
        <form id="custom-model" className={styles.modelDialog} onSubmit={submitCustom}>
          <TextField
            label="모델 이름"
            spellCheck={false}
            placeholder={billed ? '예: gpt-6-luna' : undefined}
            value={name}
            error={error ?? undefined}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
          />
          <p className={styles.hint}>
            {service}가 제공하는 글 모델 이름을 그대로 넣어 주세요. {billed && text.custom}
          </p>
        </form>
      </Dialog>
    </>
  )
}
