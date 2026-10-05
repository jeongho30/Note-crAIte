import { useEffect, useRef, useState, type RefObject } from 'react'
import { Button } from '../components'
import { findRanges } from './find'
import styles from './FindBar.module.css'

// NotePreview.module.css의 ::highlight()와 같은 이름
const ALL = 'note-find'
const CURRENT = 'note-find-current'

type Props = {
  /** 찾을 영역 (노트 본문) */
  root: RefObject<HTMLElement | null>
  /** 본문이 바뀌면 다시 찾는다 */
  content: unknown
}

// 노트 미리보기의 찾기 막대: Ctrl+F로 열고 Enter·Shift+Enter로 다음·이전, Esc로 닫는다.
export function FindBar({ root, content }: Props): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [count, setCount] = useState(0)
  const ranges = useRef<Range[]>([])
  const input = useRef<HTMLInputElement>(null)

  // 미리보기의 Esc(돌아가기)보다 먼저 받도록 capture로 듣는다
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (document.querySelector('dialog[open]')) return
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyF') {
        e.preventDefault()
        setOpen(true)
        input.current?.focus()
        input.current?.select()
      } else if (e.key === 'Escape' && open) {
        e.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  useEffect(() => {
    ranges.current = open && query && root.current ? findRanges(root.current, query) : []
    if (ranges.current.length) CSS.highlights.set(ALL, new Highlight(...ranges.current))
    else CSS.highlights.delete(ALL)
    setCount(ranges.current.length)
    setIndex(0)
  }, [open, query, content, root])

  // 지금 보는 곳: 접힌 부분(전사문) 안이면 펴고, 화면 가운데로 옮긴다
  useEffect(() => {
    const range = ranges.current[index]
    if (!range) {
      CSS.highlights.delete(CURRENT)
      return
    }
    const current = new Highlight(range)
    current.priority = 1
    CSS.highlights.set(CURRENT, current)
    const el = range.startContainer.parentElement
    const details = el?.closest('details')
    if (details) details.open = true
    el?.scrollIntoView({ block: 'center' })
  }, [index, count, open, query, content])

  useEffect(
    () => () => {
      CSS.highlights.delete(ALL)
      CSS.highlights.delete(CURRENT)
    },
    []
  )

  if (!open) return null

  const move = (step: number): void => {
    if (count) setIndex((i) => (i + step + count) % count)
  }

  return (
    <div className={styles.bar} role="search">
      <input
        ref={input}
        className={styles.input}
        value={query}
        placeholder="노트에서 찾기"
        aria-label="노트에서 찾기"
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // 한글을 조합하는 중의 Enter는 글자를 확정할 뿐이다
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) move(e.shiftKey ? -1 : 1)
        }}
      />
      <span className={styles.count} aria-live="polite">
        {count ? `${index + 1}/${count}` : query ? '없음' : ''}
      </span>
      <Button size="sm" variant="ghost" disabled={!count} aria-label="이전" title="이전 (Shift+Enter)" onClick={() => move(-1)}>
        ↑
      </Button>
      <Button size="sm" variant="ghost" disabled={!count} aria-label="다음" title="다음 (Enter)" onClick={() => move(1)}>
        ↓
      </Button>
      <Button size="sm" variant="ghost" aria-label="찾기 닫기" title="닫기 (Esc)" onClick={() => setOpen(false)}>
        ✕
      </Button>
    </div>
  )
}
