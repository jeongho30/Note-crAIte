import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { cx } from './cx'
import styles from './Toast.module.css'

type Tone = 'neutral' | 'success' | 'danger'
type Item = { id: number; message: string; tone: Tone }

const DURATION_MS = 4000

const ToastContext = createContext<((message: string, tone?: Tone) => void) | null>(null)

// 앱 맨 바깥에 한 번 둔다. 알림은 오른쪽 아래에 쌓이고 4초 뒤 사라진다.
export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [items, setItems] = useState<Item[]>([])
  const nextId = useRef(0)

  const show = useCallback((message: string, tone: Tone = 'neutral') => {
    const id = nextId.current++
    setItems((prev) => [...prev, { id, message, tone }])
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), DURATION_MS)
  }, [])

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className={styles.region} role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx(styles.toast, styles[t.tone])}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

// const toast = useToast(); toast('노트가 만들어졌어요', 'success')
export function useToast(): (message: string, tone?: Tone) => void {
  const show = useContext(ToastContext)
  if (!show) throw new Error('useToast는 ToastProvider 안에서만 쓸 수 있어요')
  return show
}
