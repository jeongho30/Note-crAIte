import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, call } from '../api'
import { Banner, Button, Dialog, SegmentedControl } from '../components'
import { cx } from '../components/cx'
import type { Language } from '../../../core/settings'
import { mb, useSetup, type LlmStatus } from '../wizard/shared'
import { aboutMinutes, lengthMinutes } from './shared'
import styles from './ConfirmDialog.module.css'
import { PC } from '../platform'

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

// 과목 칸: 녹음을 끌어 놓는 곳. subject가 null이면 미분류 칸(항상 하나, 왼쪽). 같은 과목을 언어만 달리해 두 칸까지 둘 수 있다.
type Zone = { id: number; subject: string | null; language: Language }
const NONE_ID = 0
const NONE_NAME = '미분류'

const LANG_LABEL: Record<Language, string> = { ko: '한국어', en: '영어' }
const LANGS: Language[] = ['ko', 'en']

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

// 아이콘은 글자색을 따르는 선 그림 (16×16 기준)
function Icon({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}
const PAGE = 'M4 1.75h5.25L12.5 5v9.25h-8.5z M9.25 1.75V5h3.25'
const NotesIcon = (): React.JSX.Element => (
  <Icon>
    <path d={`${PAGE} M6.25 8.25h4 M6.25 11h4`} />
  </Icon>
)
const NotesAddIcon = (): React.JSX.Element => (
  <Icon>
    <path d={`${PAGE} M8.25 7.5v4 M6.25 9.5h4`} />
  </Icon>
)
const ChevronIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M4 6l4 4 4-4" />
  </Icon>
)
const TrashIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M2.75 4.25h10.5 M6.25 4.25V2.5h3.5v1.75 M4 4.25l.6 9.25h6.8l.6-9.25 M6.75 7v4 M9.25 7v4" />
  </Icon>
)
const CloseIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M4 4l8 8 M12 4l-8 8" />
  </Icon>
)

type MenuOption = { name: string; note?: string }

// 과목 고르기 메뉴: 기존 과목 목록과 새 과목 이름 칸. 브라우저의 popover라 바깥을 누르거나 Esc를 누르면 닫히고, 대화상자의 스크롤에 잘리지 않는다.
function SubjectMenu(props: {
  className: string
  label: string
  children: ReactNode
  options: MenuOption[]
  submit: string
  /** 적은 이름을 확인해 쓸 이름을 돌려주거나, 못 쓰면 이유를 돌려준다 */
  resolve: (name: string) => { name: string } | { error: string }
  onPick: (name: string) => void
  disabled?: boolean
}): React.JSX.Element {
  const id = useId()
  const anchor = `--subject-menu-${id.replace(/[^a-zA-Z0-9]/g, '')}` // 메뉴를 이 버튼 아래에 붙이는 CSS anchor 이름
  const pop = useRef<HTMLDivElement>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const pick = (subject: string): void => {
    pop.current?.hidePopover()
    setName('')
    setError(null)
    props.onPick(subject)
  }

  return (
    <>
      <button type="button" className={props.className} aria-label={props.label} title={props.label} popoverTarget={id} disabled={props.disabled} style={{ anchorName: anchor }}>
        {props.children}
      </button>
      <div ref={pop} id={id} popover="auto" className={styles.menu} style={{ positionAnchor: anchor }}>
        {props.options.map((o) => (
          <button key={o.name} type="button" className={styles.menuItem} onClick={() => pick(o.name)}>
            {o.name}
            {o.note && <span className={styles.muted}> {o.note}</span>}
          </button>
        ))}
        <form
          className={styles.menuNew}
          onSubmit={(e) => {
            e.preventDefault()
            const r = props.resolve(name.trim())
            if ('error' in r) setError(r.error)
            else pick(r.name)
          }}
        >
          <input
            className={styles.menuInput}
            aria-label="새 과목 이름"
            placeholder="새 과목 이름"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
          />
          <Button size="sm" type="submit">
            {props.submit}
          </Button>
        </form>
        {error && (
          <p className={styles.menuError} role="alert">
            {error}
          </p>
        )}
      </div>
    </>
  )
}

type Props = {
  paths: string[]
  llm: LlmStatus | null
  onClose: () => void
}

// 시작 전 확인: 녹음을 과목 칸에 끌어 놓아 과목·강의 언어를 정하고, 예상 시간과 크레딧을 보고 시작한다.
// 녹음은 지난번에 쓴 과목 칸에 들어간 채 열린다. 하나만 넣었으면 칸의 이름을 눌러 과목을 바꾸면 된다.
export function ConfirmDialog({ paths, llm, onClose }: Props): React.JSX.Element {
  const setup = useSetup()
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [subjects, setSubjects] = useState<Subjects | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zones, setZones] = useState<Zone[]>([{ id: NONE_ID, subject: null, language: 'ko' }])
  const [place, setPlace] = useState<Record<string, number>>({}) // 녹음이 든 칸
  const [dropped, setDropped] = useState<Set<string>>(new Set()) // 뺀 필기
  const [dragging, setDragging] = useState<string | null>(null) // 끄는 녹음 (화면 표시용, 한 박자 늦게 바뀐다)
  const dragged = useRef<string | null>(null) // 끄는 녹음 (끌기 시작과 동시에 바뀐다. 놓을 수 있는지는 이것으로 본다)
  const [over, setOver] = useState<number | 'trash' | null>(null)
  const [removed, setRemoved] = useState<{ rec: Recording; zone: number } | null>(null) // 마지막에 뺀 녹음 (되돌리기)
  const [starting, setStarting] = useState(false)
  const [adding, setAdding] = useState(false)
  const nextId = useRef(1)

  useEffect(() => {
    Promise.all([call<Prepared>('inputs.prepare', paths), call<Subjects>('subjects.get')]).then(
      ([p, got]) => {
        // 저장 폴더의 "미분류" 폴더는 과목이 아니다 (왼쪽의 미분류 칸이 그 폴더다)
        const s = { ...got, subjects: got.subjects.filter((name) => name !== NONE_NAME) }
        const subject = s.lastSubject && s.subjects.includes(s.lastSubject) ? s.lastSubject : (s.subjects[0] ?? null)
        const first: Zone[] = subject ? [{ id: nextId.current++, subject, language: s.subjectLanguage[subject] ?? 'ko' }] : []
        const home = first[0]?.id ?? NONE_ID
        setPrepared(p)
        setSubjects(s)
        setZones([{ id: NONE_ID, subject: null, language: 'ko' }, ...first])
        setPlace(Object.fromEntries(p.recordings.map((r) => [r.audio, home])))
      },
      (e) => setError(e instanceof ApiError ? e.message : '녹음을 확인하지 못했어요.')
    )
  }, [paths])

  const recs = prepared?.recordings ?? []
  const subjectZones = zones.filter((z) => z.subject !== null)
  const inZone = (id: number): Recording[] => recs.filter((r) => place[r.audio] === id)

  /** 같은 과목의 다른 칸이 쓰는 언어 */
  const takenLanguages = (subject: string, except?: number): Language[] => zones.filter((z) => z.id !== except && z.subject === subject).map((z) => z.language)
  /** 이 과목으로 칸을 만들 때의 언어: 그 과목에 저장해 둔 언어, 그 칸이 이미 있으면 다른 언어, 둘 다 있으면 null */
  const languageFor = (subject: string, except?: number): Language | null => {
    const taken = takenLanguages(subject, except)
    const prefer = subjects?.subjectLanguage[subject] ?? 'ko'
    return [prefer, ...LANGS].find((l) => !taken.includes(l)) ?? null
  }
  const knownSubjects = [...new Set([...(subjects?.subjects ?? []), ...subjectZones.map((z) => z.subject!)])]
  const menuOptions = (except?: Zone): MenuOption[] =>
    knownSubjects.flatMap((name) => {
      if (name === except?.subject) return []
      const language = languageFor(name, except?.id)
      if (!language) return []
      return [{ name, note: takenLanguages(name, except?.id).length ? `(${LANG_LABEL[language]}로 하나 더)` : undefined }]
    })
  const resolveName = (typed: string, except?: Zone): { name: string } | { error: string } => {
    if (!typed) return { error: '과목 이름을 적어 주세요.' }
    if (/[\\/:*?"<>|]/.test(typed) || typed.endsWith('.')) return { error: '폴더 이름으로 쓸 수 없는 글자가 있어요.' }
    if (typed === NONE_NAME) return { error: '과목 없이 저장하려면 왼쪽의 미분류 칸에 넣어 주세요.' }
    const name = knownSubjects.find((s) => s.toLowerCase() === typed.toLowerCase()) ?? typed
    if (name === except?.subject) return { name }
    return languageFor(name, except?.id) ? { name } : { error: '이 과목의 칸이 이미 있어요.' }
  }

  const addZone = (subject: string): void => {
    const language = languageFor(subject)
    if (language) setZones((z) => [...z, { id: nextId.current++, subject, language }])
  }
  // 칸의 과목을 바꾸면 그 과목의 강의 언어 기본값으로 맞춘다 (여기서 바꾼 언어는 이 녹음들에만)
  const renameZone = (zone: Zone, subject: string): void => {
    if (subject === zone.subject) return
    const language = languageFor(subject, zone.id)
    if (language) setZones((zs) => zs.map((z) => (z.id === zone.id ? { ...z, subject, language } : z)))
  }

  const endDrag = (): void => {
    dragged.current = null
    setDragging(null)
    setOver(null)
  }
  const moveTo = (zone: number): void => {
    const audio = dragged.current
    if (audio) setPlace((p) => ({ ...p, [audio]: zone }))
    endDrag()
  }
  // 목록에서 녹음을 뺀다. 잘못 끌어 놓았을 때를 위해 마지막 하나는 되돌릴 수 있다
  const removeDragged = (): void => {
    const rec = recs.find((r) => r.audio === dragged.current)
    if (rec) {
      setRemoved({ rec, zone: place[rec.audio] ?? NONE_ID })
      setPrepared((p) => (p ? { ...p, recordings: p.recordings.filter((r) => r.audio !== rec.audio) } : p))
    }
    endDrag()
  }
  const undoRemove = (): void => {
    if (!removed) return
    const { rec, zone } = removed
    setPrepared((p) => (p && !p.recordings.some((r) => r.audio === rec.audio) ? { ...p, recordings: [...p.recordings, rec] } : p))
    setPlace((p) => ({ ...p, [rec.audio]: zones.some((z) => z.id === zone) ? zone : NONE_ID }))
    setRemoved(null)
  }

  // 필기 아이콘: 붙은 필기를 빼거나 되돌리고, 필기가 없으면 파일을 골라 붙인다
  async function toggleNotes(r: Recording): Promise<void> {
    if (r.notes) {
      setDropped((d) => {
        const next = new Set(d)
        if (!next.delete(r.audio)) next.add(r.audio)
        return next
      })
      return
    }
    try {
      const picked = await call<{ path: string; name: string } | null>('inputs.pickNotes')
      if (!picked) return
      setPrepared((p) => (p ? { ...p, recordings: p.recordings.map((x) => (x.audio === r.audio ? { ...x, notes: picked.path, notesName: picked.name } : x)) } : p))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '필기를 넣지 못했어요.')
    }
  }

  // 파일 선택 창으로 녹음·필기를 더 넣는다 (넣은 파일도 같은 방식으로 필기 짝을 찾고 길이를 읽는다). 새 녹음은 첫 과목 칸에 들어간다
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
      const home = subjectZones[0]?.id ?? NONE_ID
      setPlace((p) => ({ ...Object.fromEntries(more.recordings.map((r) => [r.audio, home])), ...p }))
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

  // ChatKHU로 받아쓰면 이 PC의 받아쓰기 모델이 없어도 된다
  const cloud = prepared?.stt === 'chatkhu'
  const modelReady = cloud || setup?.model.state === 'ready'
  const sttCreditTotal = recs.every((r) => r.sttCredits !== null) ? recs.reduce((n, r) => n + r.sttCredits!, 0) : null
  const sttTotal = recs.every((r) => r.sttS !== null) ? recs.reduce((n, r) => n + r.sttS!, 0) : null
  // 소수 첫째 자리 값을 더하면 3.9 + 3.9 + 3.9 = 11.700000000000001처럼 되어 다시 반올림한다
  const creditTotal = recs.every((r) => r.credits !== null) ? Math.round(recs.reduce((n, r) => n + r.credits!, 0) * 10) / 10 : null
  const total = recs.every((r) => r.totalS !== null) ? recs.reduce((n, r) => n + r.totalS!, 0) : null

  // 받아쓰는 장치는 보여 주지 않고 걸리는 시간만 안내한다
  const sttLine = useMemo(() => {
    if (cloud) return `ChatKHU Soniox로 받아써요${sttCreditTotal !== null ? ` · 약 ${sttCreditTotal.toLocaleString()}크레딧 소모 예상` : ''}`
    if (!modelReady) return `받아쓰기 모델(${setup ? mb(setup.model.total) : '약 875MB'})을 받은 뒤 시작해요`
    return sttTotal !== null ? aboutMinutes(sttTotal) : `이 ${PC}의 속도를 잰 뒤 알려 드려요`
  }, [cloud, sttCreditTotal, modelReady, sttTotal, setup])

  async function start(): Promise<void> {
    setStarting(true)
    try {
      // 과목 칸 순서대로, 미분류는 마지막에 처리한다
      await call(
        'jobs.start',
        [...subjectZones, zones[0]].flatMap((z) =>
          inZone(z.id).map((r) => ({ audio: r.audio, notes: dropped.has(r.audio) ? null : r.notes, subject: z.subject, language: z.language }))
        )
      )
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '시작하지 못했어요.')
      setStarting(false)
    }
  }

  const loading = !prepared && !error
  const nothing = prepared && recs.length === 0 && !removed

  function fileRow(r: Recording): React.JSX.Element {
    const on = r.notes !== null && !dropped.has(r.audio)
    const notesLabel = on ? `필기 ${r.notesName} · 누르면 빼요` : r.notes ? `필기 ${r.notesName} 뺌 · 누르면 다시 넣어요` : '필기 없음 · 누르면 파일을 골라 넣어요'
    return (
      <li
        key={r.audio}
        className={cx(styles.file, dragging === r.audio && styles.fileDragging)}
        draggable={!starting}
        title={[r.name, r.durationS ? lengthMinutes(r.durationS) : null, `녹음 ${recordedLabel(r.recordedAt)}`].filter(Boolean).join(' · ')}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', r.name)
          dragged.current = r.audio
          // 끄는 그림이 만들어진 뒤에 화면을 바꾼다 (바로 바꾸면 끌기가 취소될 수 있다)
          setTimeout(() => dragged.current === r.audio && setDragging(r.audio), 0)
        }}
        onDragEnd={endDrag}
      >
        <span className={styles.grip} aria-hidden="true" />
        <span className={styles.fileName}>{r.name}</span>
        <button type="button" className={cx(styles.notes, on && styles.notesOn)} aria-label={notesLabel} title={notesLabel} disabled={starting} onClick={() => void toggleNotes(r)}>
          {on ? <NotesIcon /> : <NotesAddIcon />}
        </button>
        {r.durationS !== null && <span className={styles.muted}>{lengthMinutes(r.durationS)}</span>}
      </li>
    )
  }

  function zoneBox(z: Zone): React.JSX.Element {
    const files = inZone(z.id)
    const taken = z.subject === null ? [] : takenLanguages(z.subject, z.id)
    return (
      <section
        key={z.id}
        className={cx(styles.zone, over === z.id && styles.zoneOver)}
        onDragOver={(e) => {
          if (!dragged.current) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setOver(z.id)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === z.id ? null : o))
        }}
        onDrop={(e) => {
          e.preventDefault()
          moveTo(z.id)
        }}
      >
        <div className={styles.zoneHead}>
          {z.subject === null ? (
            <span className={styles.zoneName}>
              <span className={styles.zoneTitle}>{NONE_NAME}</span>
              <span className={styles.muted}>{files.length}</span>
            </span>
          ) : (
            <SubjectMenu
              className={cx(styles.zoneName, styles.zonePick)}
              label={`${z.subject} · 누르면 이 칸의 과목을 바꿔요`}
              options={menuOptions(z)}
              submit="바꾸기"
              resolve={(n) => resolveName(n, z)}
              onPick={(n) => renameZone(z, n)}
              disabled={starting}
            >
              <span className={styles.zoneTitle}>{z.subject}</span>
              <ChevronIcon />
              <span className={styles.muted}>{files.length}</span>
            </SubjectMenu>
          )}
          <SegmentedControl
            label="강의 언어"
            value={z.language}
            options={LANGS.map((l) => ({ value: l, label: LANG_LABEL[l], disabled: taken.includes(l) }))}
            onChange={(language) => setZones((zs) => zs.map((x) => (x.id === z.id ? { ...x, language } : x)))}
          />
          {z.subject !== null && files.length === 0 && (
            <button type="button" className={styles.zoneClose} aria-label={`${z.subject} 칸 지우기`} title="이 칸 지우기" onClick={() => setZones((zs) => zs.filter((x) => x.id !== z.id))}>
              <CloseIcon />
            </button>
          )}
        </div>
        {z.subject === null && <span className={styles.muted}>저장 폴더의 "{NONE_NAME}" 폴더에 저장돼요</span>}
        {files.length > 0 ? (
          <ul className={styles.files}>{files.map(fileRow)}</ul>
        ) : (
          <p className={styles.empty}>{z.subject === null ? '과목 없이 저장할 녹음을 끌어 놓으세요' : '여기에 끌어 놓으세요'}</p>
        )}
      </section>
    )
  }

  return (
    <Dialog
      open
      size="xl"
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
            <Button variant="primary" disabled={loading || recs.length === 0 || starting} onClick={() => void start()}>
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

        {prepared && subjects && (
          <>
            <div className={styles.cols}>
              <div className={cx(styles.col, styles.left)}>
                {zoneBox(zones[0])}
                {dragging ? (
                  <div
                    className={cx(styles.trash, over === 'trash' && styles.trashOver)}
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      setOver('trash')
                    }}
                    onDragLeave={() => setOver((o) => (o === 'trash' ? null : o))}
                    onDrop={(e) => {
                      e.preventDefault()
                      removeDragged()
                    }}
                  >
                    <TrashIcon /> 여기에 놓으면 이 녹음을 빼요
                  </div>
                ) : (
                  <button type="button" className={styles.add} disabled={adding || starting} onClick={() => void addRecordings()}>
                    <span className={styles.plus} aria-hidden="true" />
                    {adding ? '넣는 중…' : '파일 추가'}
                  </button>
                )}
                {removed && (
                  <p className={styles.undo}>
                    {removed.rec.name} 녹음을 뺐어요 ·{' '}
                    <Button variant="link" onClick={undoRemove}>
                      되돌리기
                    </Button>
                  </p>
                )}
              </div>
              <div className={styles.col}>
                {subjectZones.map(zoneBox)}
                <SubjectMenu className={styles.add} label="과목 추가" options={menuOptions()} submit="추가" resolve={(n) => resolveName(n)} onPick={addZone} disabled={starting}>
                  <span className={styles.plus} aria-hidden="true" />
                  과목 추가
                </SubjectMenu>
              </div>
            </div>

            {recs.length > 0 && (
              <>
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
                        ? `이 ${PC}의 속도를 잰 뒤 알려 드려요`
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
