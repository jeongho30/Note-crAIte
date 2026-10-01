import { useEffect, useMemo, useState } from 'react'
import { ApiError, call } from '../api'
import { Banner, Button, Dialog, SegmentedControl, Select, TextField } from '../components'
import { cx } from '../components/cx'
import type { Language } from '../../../core/settings'
import { mb, useSetup, type LlmStatus } from '../wizard/shared'
import { aboutMinutes, lengthMinutes } from './shared'
import styles from './ConfirmDialog.module.css'

type Recording = {
  audio: string
  name: string
  notes: string | null
  notesName: string | null
  durationS: number | null
  recordedAt: string
  sttS: number | null
  credits: number | null
  sttCredits: number | null
  totalS: number | null
}
type Prepared = { recordings: Recording[]; rejected: { name: string; reason: string }[]; stt: 'whisper' | 'chatkhu' }
type Subjects = { subjects: string[]; lastSubject: string | null; subjectLanguage: Record<string, Language> }

// 과목 고르기: 저장 폴더의 과목 폴더, 미분류, 새 과목
const NONE = '\u0000none'
const NEW = '\u0000new'
type Choice = { pick: string; newName: string; language: Language }

const LANGS: { value: Language; label: string }[] = [
  { value: 'ko', label: '한국어' },
  { value: 'en', label: '영어' }
]

function subjectOf(c: Choice): string | null {
  if (c.pick === NONE) return null
  if (c.pick === NEW) return c.newName.trim() || null
  return c.pick
}

/** 뺀 파일 안내에서 같은 파일이 여러 번 나오지 않게 하고, 그 뒤에 목록의 녹음에 붙은 필기는 안내에서 뺀다 */
function tidy(p: Prepared): Prepared {
  const attached = new Set(p.recordings.map((r) => r.notesName?.toLowerCase()))
  const seen = new Set<string>()
  const rejected = p.rejected.filter((r) => {
    const key = `${r.name.toLowerCase()}|${r.reason}`
    if (seen.has(key) || attached.has(r.name.toLowerCase())) return false
    seen.add(key)
    return true
  })
  return { ...p, rejected }
}

function recordedLabel(iso: string): string {
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function SubjectPicker({ subjects, value, onChange, idPrefix }: { subjects: string[]; value: Choice; onChange: (c: Choice) => void; idPrefix?: string }) {
  return (
    <div className={styles.picker}>
      <Select
        label="과목"
        value={value.pick}
        onChange={(e) => onChange({ ...value, pick: e.target.value })}
        hint={value.pick === NONE ? '저장 폴더의 "미분류" 폴더에 저장돼요.' : undefined}
      >
        {subjects.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
        <option value={NONE}>미분류 (과목 없음)</option>
        <option value={NEW}>+ 새 과목</option>
      </Select>
      {value.pick === NEW && (
        <TextField
          id={idPrefix ? `${idPrefix}-new` : undefined}
          label="새 과목 이름"
          placeholder="예: 컴파일러"
          autoFocus
          value={value.newName}
          onChange={(e) => onChange({ ...value, newName: e.target.value })}
          hint="저장 폴더 안에 이 이름의 폴더가 생겨요."
        />
      )}
      <div className={styles.lang}>
        <span className={styles.langLabel}>강의 언어</span>
        <SegmentedControl label="강의 언어" value={value.language} options={LANGS} onChange={(language) => onChange({ ...value, language })} />
      </div>
    </div>
  )
}

type Props = {
  paths: string[]
  llm: LlmStatus | null
  onClose: () => void
}

// 시작 전 확인: 녹음마다 한 번. 과목·강의 언어를 정하고 예상 시간과 크레딧을 보고 시작한다.
// 여러 녹음은 한 번에 정하되, 파일별로 따로 정할 수 있다.
export function ConfirmDialog({ paths, llm, onClose }: Props): React.JSX.Element {
  const setup = useSetup()
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [subjects, setSubjects] = useState<Subjects | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [all, setAll] = useState<Choice | null>(null)
  const [own, setOwn] = useState<Record<string, Choice>>({}) // 따로 정한 파일
  const [dropped, setDropped] = useState<Set<string>>(new Set()) // 뺀 필기
  const [starting, setStarting] = useState(false)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    Promise.all([call<Prepared>('inputs.prepare', paths), call<Subjects>('subjects.get')]).then(
      ([p, s]) => {
        setPrepared(p)
        setSubjects(s)
        const pick = s.lastSubject && s.subjects.includes(s.lastSubject) ? s.lastSubject : (s.subjects[0] ?? NEW)
        setAll({ pick, newName: '', language: s.subjectLanguage[pick] ?? 'ko' })
      },
      (e) => setError(e instanceof ApiError ? e.message : '녹음을 확인하지 못했어요.')
    )
  }, [paths])

  // 과목을 바꾸면 그 과목의 강의 언어 기본값으로 맞춘다 (여기서 바꾼 언어는 이 녹음에만)
  const withDefaultLanguage = (prev: Choice, next: Choice): Choice =>
    next.pick !== prev.pick ? { ...next, language: subjects?.subjectLanguage[next.pick] ?? 'ko' } : next

  // 목록에서 녹음을 빼고, 파일 선택 창으로 녹음·필기를 더 넣는다 (넣은 파일도 같은 방식으로 필기 짝을 찾고 길이를 읽는다)
  const removeRecording = (audio: string): void => setPrepared((p) => (p ? { ...p, recordings: p.recordings.filter((r) => r.audio !== audio) } : p))

  async function addRecordings(): Promise<void> {
    setAdding(true)
    try {
      const picked = await call<string[]>('inputs.pick')
      if (!picked.length) return
      // 이미 목록에 있는 녹음과 이름이 같은 필기는 그 녹음에 붙이고, 나머지만 새로 확인한다
      const { attached, rest } = await call<{ attached: { audio: string; notes: string; notesName: string }[]; rest: string[] }>('inputs.attach', {
        existing: recs.map((r) => r.audio),
        picked
      })
      if (attached.length) {
        const by = new Map(attached.map((a) => [a.audio, a]))
        setPrepared((p) =>
          p ? tidy({ ...p, recordings: p.recordings.map((r) => (by.has(r.audio) ? { ...r, notes: by.get(r.audio)!.notes, notesName: by.get(r.audio)!.notesName } : r)) }) : p
        )
        setDropped((d) => new Set([...d].filter((x) => !by.has(x))))
      }
      if (!rest.length) return
      const more = await call<Prepared>('inputs.prepare', rest)
      setPrepared((p) => {
        if (!p) return more
        const has = new Set(p.recordings.map((r) => r.audio.toLowerCase()))
        return tidy({ ...p, recordings: [...p.recordings, ...more.recordings.filter((r) => !has.has(r.audio.toLowerCase()))], rejected: [...p.rejected, ...more.rejected] })
      })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '녹음을 넣지 못했어요.')
    } finally {
      setAdding(false)
    }
  }

  const recs = prepared?.recordings ?? []
  const choiceOf = (r: Recording): Choice => own[r.audio] ?? all!
  const invalid = recs.some((r) => {
    const c = choiceOf(r)
    return c.pick === NEW && !c.newName.trim()
  })
  // ChatKHU로 받아쓰면 이 PC의 받아쓰기 모델이 없어도 된다
  const cloud = prepared?.stt === 'chatkhu'
  const modelReady = cloud || setup?.model.state === 'ready'
  const sttCreditTotal = recs.every((r) => r.sttCredits !== null) ? recs.reduce((n, r) => n + r.sttCredits!, 0) : null
  const sttTotal = recs.every((r) => r.sttS !== null) ? recs.reduce((n, r) => n + r.sttS!, 0) : null
  const creditTotal = recs.every((r) => r.credits !== null) ? recs.reduce((n, r) => n + r.credits!, 0) : null
  const total = recs.every((r) => r.totalS !== null) ? recs.reduce((n, r) => n + r.totalS!, 0) : null

  // 받아쓰는 장치는 보여 주지 않고 걸리는 시간만 안내한다
  const sttLine = useMemo(() => {
    if (cloud) return `ChatKHU Soniox로 받아써요${sttCreditTotal !== null ? ` · 약 ${sttCreditTotal.toLocaleString()}크레딧 소모 예상` : ''}`
    if (!modelReady) return `받아쓰기 모델(${setup ? mb(setup.model.total) : '약 875MB'})을 받은 뒤 시작해요`
    return sttTotal !== null ? aboutMinutes(sttTotal) : '이 PC의 속도를 잰 뒤 알려 드려요'
  }, [cloud, sttCreditTotal, modelReady, sttTotal, setup])

  async function start(): Promise<void> {
    setStarting(true)
    try {
      await call(
        'jobs.start',
        recs.map((r) => {
          const c = choiceOf(r)
          return { audio: r.audio, notes: dropped.has(r.audio) ? null : r.notes, subject: subjectOf(c), language: c.language }
        })
      )
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '시작하지 못했어요.')
      setStarting(false)
    }
  }

  const loading = !prepared && !error
  const nothing = prepared && recs.length === 0

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={loading ? '녹음을 확인하고 있어요' : nothing ? '넣을 수 있는 녹음이 없어요' : '시작하기 전에 확인해 주세요'}
      actions={
        nothing || (error && !prepared) ? (
          <Button onClick={onClose}>닫기</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              취소
            </Button>
            <Button variant="primary" disabled={loading || invalid || starting} onClick={() => void start()}>
              {modelReady ? '시작' : '받고 시작'}
            </Button>
          </>
        )
      }
    >
      <div className={styles.body}>
        {loading && <p className={styles.muted}>길이와 녹음 시각을 읽는 중이에요…</p>}
        {error && <Banner tone="danger">{error}</Banner>}

        {prepared && prepared.rejected.length > 0 && (
          <Banner tone="warning" title={`${prepared.rejected.length}개는 뺐어요`}>
            {prepared.rejected.map((r) => `${r.name} (${r.reason})`).join(', ')}
          </Banner>
        )}

        {prepared && subjects && all && (
          <>
            {recs.length > 0 && (
              <ul className={styles.files}>
                {recs.map((r) => {
                  const c = own[r.audio]
                  return (
                    <li key={r.audio} className={styles.file}>
                      <div className={styles.fileHead}>
                        <button type="button" className={styles.remove} aria-label={`${r.name} 빼기`} title="이 녹음 빼기" disabled={starting} onClick={() => removeRecording(r.audio)} />
                        <div className={styles.fileMain}>
                          <b className={styles.fileName}>{r.name}</b>
                          <span className={styles.muted}>
                            {[r.durationS ? lengthMinutes(r.durationS) : null, `녹음 ${recordedLabel(r.recordedAt)}`].filter(Boolean).join(' · ')}
                          </span>
                        </div>
                        {recs.length > 1 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setOwn((o) => {
                                const next = { ...o }
                                if (next[r.audio]) delete next[r.audio]
                                else next[r.audio] = { ...all }
                                return next
                              })
                            }
                          >
                            {c ? '같이 정하기' : '따로 정하기'}
                          </Button>
                        )}
                      </div>
                      {r.notes && (
                        <div className={styles.notesLine}>
                          {dropped.has(r.audio) ? (
                            <>
                              <span className={styles.iconSpace} aria-hidden="true" />
                              <span className={styles.muted}>필기를 빼고 넣어요</span>
                              <Button variant="link" onClick={() => setDropped((d) => new Set([...d].filter((x) => x !== r.audio)))}>
                                되돌리기
                              </Button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                className={cx(styles.remove, styles.removeSm)}
                                aria-label={`${r.notesName} 빼기`}
                                title="이 필기 빼기"
                                disabled={starting}
                                onClick={() => setDropped((d) => new Set(d).add(r.audio))}
                              />
                              <span>
                                필기 <b>{r.notesName}</b> <span className={styles.muted}>· 같은 이름이라 함께 넣었어요</span>
                              </span>
                            </>
                          )}
                        </div>
                      )}
                      {c && (
                        <SubjectPicker
                          subjects={subjects.subjects}
                          value={c}
                          idPrefix={`own-${r.name}`}
                          onChange={(next) => setOwn((o) => ({ ...o, [r.audio]: withDefaultLanguage(c, next) }))}
                        />
                      )}
                    </li>
                  )
                })}
              </ul>
            )}

            <button type="button" className={styles.add} disabled={adding || starting} onClick={() => void addRecordings()}>
              <span className={styles.plus} aria-hidden="true" />
              {adding ? '넣는 중…' : '파일 추가'}
            </button>

            {recs.length > 0 && (
              <>
                {recs.some((r) => !own[r.audio]) && (
                  <div className={styles.group}>
                    {Object.keys(own).length > 0 && <span className={styles.groupLabel}>나머지 녹음</span>}
                    <SubjectPicker subjects={subjects.subjects} value={all} onChange={(next) => setAll(withDefaultLanguage(all, next))} />
                  </div>
                )}

                {!modelReady && <Banner tone="warning" title="받아쓰기 모델이 필요해요">[받고 시작]을 누르면 모델을 받고, 다 받으면 바로 시작해요.</Banner>}

                <dl className={styles.summary}>
                  <dt>받아쓰기</dt>
                  <dd>
                    {sttLine}
                    {recs.length > 1 && ' · 한 번에 하나씩 해요'}
                  </dd>
                  <dt>요약</dt>
                  <dd>
                    {llm?.summary
                      ? [
                          llm.summary.local ? `${llm.summary.name}(${llm.summary.model})` : llm.summary.name,
                          llm.polish?.local && !llm.summary.local ? `다듬기는 ${llm.polish.name}` : null,
                          creditTotal !== null ? `약 ${creditTotal}크레딧 소모 예상` : null,
                          creditTotal !== null && llm.credits != null ? `남은 크레딧 ${llm.credits.toLocaleString()}` : null
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : '요약 없이 전사문만 만들어요'}
                  </dd>
                  <dt>예상 총 소요 시간</dt>
                  <dd className={styles.total}>
                    {cloud
                      ? 'ChatKHU 서버에 따라 달라요'
                      : total !== null && modelReady
                      ? aboutMinutes(total)
                      : modelReady
                        ? '이 PC의 속도를 잰 뒤 알려 드려요'
                        : '모델을 받고 속도를 잰 뒤 알려 드려요'}
                  </dd>
                </dl>
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}
