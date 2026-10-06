import { useEffect, useState } from 'react'
import { ApiError, call } from '../api'
import { Button, TextArea, useToast } from '../components'
import { cx } from '../components/cx'
import { Block } from './parts'
import styles from './Settings.module.css'

// base는 앱 기본 프롬프트, extra는 저장된 추가 지시, custom은 통째로 고쳐 저장한 프롬프트 (없으면 null)
type State = { base: string; extra: string | null; custom: string | null }

/** 읽기 전용 프롬프트 칸을 이만큼 누르면 전체 수정이 열린다 (안드로이드의 개발자 옵션처럼) */
const UNLOCK_CLICKS = 10
/** 남은 횟수를 알려 주기 시작하는 때 */
const COUNTDOWN_FROM = 3

// 설정 > 고급 > 요약 세부설정의 요약 프롬프트: 앱 기본 프롬프트(읽기 전용)와 그 뒤에 붙는 추가 지시.
// 전체 수정은 숨겨 둔다: JSON 형식과 교정 규칙까지 고칠 수 있어 요약이 깨지거나 전사문이 잘못 고쳐질 수 있다.
// 프롬프트 칸을 10번 누르면 열리고, 고쳐 저장한 프롬프트가 있으면 처음부터 열려 있다.
export function SummaryPrompt(): React.JSX.Element {
  const toast = useToast()
  const [saved, setSaved] = useState<State | null>(null)
  const [extra, setExtra] = useState('')
  // 전체 수정 칸에 쓴 글. null이면 손대지 않은 것: 앱 기본을 보이고 저장도 기본으로 한다
  const [custom, setCustom] = useState<string | null>(null)
  const [unlocked, setUnlocked] = useState(false)
  const [clicks, setClicks] = useState(0)
  const [saving, setSaving] = useState(false)

  function apply(s: State): void {
    setSaved(s)
    setExtra(s.extra ?? '')
    setCustom(s.custom)
  }

  useEffect(() => {
    call<State>('prompt.get').then((s) => {
      apply(s)
      setUnlocked(s.custom !== null)
    })
  }, [])

  if (!saved) {
    return (
      <Block title="요약 프롬프트">
        <p className={styles.hint}>불러오는 중…</p>
      </Block>
    )
  }

  // 저장할 고친 프롬프트: 손대지 않았거나 앱 기본과 같으면 없음
  const edited = custom === null || custom.trim() === saved.base ? null : custom.trim()
  const dirty = extra.trim() !== (saved.extra ?? '') || edited !== saved.custom
  const left = UNLOCK_CLICKS - clicks

  function tap(): void {
    setClicks(clicks + 1)
    if (left > 1) return
    setUnlocked(true)
    toast('전체 프롬프트를 고칠 수 있어요.')
  }

  async function save(): Promise<void> {
    setSaving(true)
    try {
      apply(await call<State>('prompt.save', { extra, custom: edited }))
      toast('요약 프롬프트를 저장했어요. 다음 요약부터 쓰여요.', 'success')
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '저장하지 못했어요.', 'danger')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Block title="요약 프롬프트">
      {unlocked ? (
        <TextArea
          label="프롬프트 전체 수정"
          rows={14}
          spellCheck={false}
          value={custom ?? saved.base}
          onChange={(e) => setCustom(e.target.value)}
          hint="JSON 형식이나 corrections 규칙을 바꾸면 요약이 실패하거나 전사문이 잘못 고쳐질 수 있어요. 고친 프롬프트를 쓰는 동안에는 앱의 기본 프롬프트가 바뀌어도 반영되지 않아요."
        />
      ) : (
        <div className={styles.field}>
          <span className={styles.fieldLabel}>기본 프롬프트 (읽기 전용)</span>
          <p className={cx(styles.code, styles.prompt)} onClick={tap}>
            {saved.base}
          </p>
          {left <= COUNTDOWN_FROM && <p className={styles.hint}>{left}번 더 누르면 전체 프롬프트를 고칠 수 있어요.</p>}
        </div>
      )}

      <TextArea
        label="추가 지시"
        rows={3}
        placeholder="예: 용어는 처음 나올 때 한글(English)로 함께 적어 주세요."
        value={extra}
        onChange={(e) => setExtra(e.target.value)}
        hint="요약을 쓰는 방식(분량, 문체, 용어 표기 등)에 더할 지시를 적어요. 위 프롬프트 뒤에 붙고, 다음 요약과 [요약 다시 만들기]부터 쓰여요. 비워 두면 앱 기본 그대로예요."
      />

      <div className={styles.btns}>
        {unlocked && (
          <Button size="sm" variant="ghost" disabled={edited === null} onClick={() => setCustom(null)}>
            기본 프롬프트로 되돌리기
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
          저장
        </Button>
      </div>
    </Block>
  )
}
