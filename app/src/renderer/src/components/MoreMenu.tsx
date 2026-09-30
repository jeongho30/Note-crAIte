import { useEffect, useId, useRef, useState } from 'react'
import { cx } from './cx'
import styles from './MoreMenu.module.css'

export type MoreMenuItem = { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }

type Props = {
  /** 화면 낭독기용 버튼 이름 (예: "노트 더 보기") */
  label: string
  items: MoreMenuItem[]
  className?: string
}

// [...] 버튼을 누르면 아래에 메뉴가 열린다. 바깥을 누르거나 Esc를 누르면 닫히고, 위·아래 화살표로 고를 수 있다.
export function MoreMenu({ label, items, className }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault() // 미리보기의 Esc(돌아가기)가 함께 일어나지 않게
      setOpen(false)
      root.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function onMenuKey(e: React.KeyboardEvent): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const all = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    const at = all.indexOf(document.activeElement as HTMLButtonElement)
    all[(at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
  }

  return (
    <div ref={root} className={cx(styles.root, className)}>
      <button type="button" className={styles.trigger} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(!open)}>
        <span className={styles.dots} aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId} role="menu" className={styles.menu} onKeyDown={onMenuKey}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={cx(styles.item, item.danger && styles.danger)}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                item.onClick()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
