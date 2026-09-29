import { useMemo, useState } from 'react'
import { Button, Dialog, Select, TextField } from '../components'
import { cx } from '../components/cx'
import styles from './Settings.module.css'

export type ModelOption = {
  id: string
  owner: string | null
  /** 추천 목록의 묶음. null이면 [전체 모델 보기]에만 보인다 */
  group: '권장' | '더 싸게' | '더 좋게' | null
  note: string | null
  /** 90분 강의 요약 1회의 크레딧 */
  credits90: number | null
  /** measured: 써 본 기록, estimate: 단가표로 어림 */
  source: 'measured' | 'estimate' | null
}

const ALL = '\u0000all'
const GROUPS = ['권장', '더 싸게', '더 좋게'] as const

/** "약 12크레딧", 10 미만은 소수 한 자리 */
function credits(m: ModelOption): string {
  if (m.credits90 == null) return '크레딧 모름'
  const v = m.credits90 < 10 ? Math.round(m.credits90 * 10) / 10 : Math.round(m.credits90)
  return `약 ${v}크레딧${m.source === 'estimate' ? '(어림)' : ''}`
}

type Props = {
  models: ModelOption[] | null
  selected: string | null
  disabled: boolean
  /** 목록을 불러오지 못함 (인터넷 연결 등) */
  failed: boolean
  onPick: (id: string) => void
}

// 요약 모델: 추천 목록(권장·더 싸게·더 좋게)을 먼저 보이고, 나머지는 [전체 모델 보기] 창에서 찾아 고른다.
export function ModelPicker({ models, selected, disabled, failed, onPick }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const current = models?.find((m) => m.id === selected) ?? null
  const featured = (models ?? []).filter((m) => m.group)

  // 창 안의 목록: 만든 곳(owner)끼리 묶고, 검색어가 있으면 이름·만든 곳으로 거른다
  const byOwner = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const shown = (models ?? []).filter((m) => words.every((w) => `${m.id} ${m.owner ?? ''}`.toLowerCase().includes(w)))
    const groups = new Map<string, ModelOption[]>()
    for (const m of shown) {
      const owner = m.owner ?? '기타'
      groups.set(owner, [...(groups.get(owner) ?? []), m])
    }
    return [...groups.entries()]
  }, [models, query])

  const hint = disabled
    ? '요약 서비스를 연결하면 고를 수 있어요.'
    : failed
      ? '모델 목록을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.'
      : [current?.note, '크레딧은 90분 강의 요약 1회 기준이에요. (어림)은 단가표로 계산한 값이라 실제와 다를 수 있어요.'].filter(Boolean).join(' · ')

  return (
    <>
      <Select
        label="요약 모델"
        disabled={disabled || !models}
        value={selected ?? ''}
        onChange={(e) => {
          if (e.target.value === ALL) setOpen(true)
          else onPick(e.target.value)
        }}
        hint={hint}
      >
        {!models && <option value="">{disabled ? '연결된 서비스 없음' : '불러오는 중…'}</option>}
        {models &&
          GROUPS.map((g) => {
            const list = featured.filter((m) => m.group === g)
            return (
              list.length > 0 && (
                <optgroup key={g} label={g}>
                  {list.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id} · {credits(m)}
                    </option>
                  ))}
                </optgroup>
              )
            )
          })}
        {current && !current.group && (
          <optgroup label="고른 모델">
            <option value={current.id}>
              {current.id} · {credits(current)}
            </option>
          </optgroup>
        )}
        {models && models.length > featured.length && <option value={ALL}>전체 모델 보기… ({models.length}개)</option>}
      </Select>

      <Dialog
        open={open}
        size="lg"
        onClose={() => setOpen(false)}
        title="요약 모델 고르기"
        actions={<Button onClick={() => setOpen(false)}>닫기</Button>}
      >
        <div className={styles.modelDialog}>
          <TextField label="찾기" type="search" placeholder="모델 이름이나 만든 곳 (예: claude, gpt)" value={query} onChange={(e) => setQuery(e.target.value)} />
          <p className={styles.hint}>크레딧은 90분 강의 요약 1회 기준이에요. (어림)은 단가표로 계산한 값이고, 써 본 모델은 실제로 쓴 크레딧을 보여 드려요.</p>
          {byOwner.length === 0 && <p className={styles.hint}>찾는 모델이 없어요.</p>}
          {byOwner.map(([owner, list]) => (
            <section key={owner} className={styles.modelGroup} aria-label={owner}>
              <h3>{owner}</h3>
              {list.map((m) => (
                <button
                  key={m.id}
                  className={cx(styles.modelRow, m.id === selected && styles.modelRowOn)}
                  aria-current={m.id === selected ? 'true' : undefined}
                  onClick={() => {
                    onPick(m.id)
                    setOpen(false)
                  }}
                >
                  <span className={styles.modelName}>
                    {m.id}
                    {m.group && <span className={styles.modelTag}>{m.group}</span>}
                  </span>
                  <span className={styles.modelCredits}>{credits(m)}</span>
                </button>
              ))}
            </section>
          ))}
        </div>
      </Dialog>
    </>
  )
}
