import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { cx } from './cx'
import styles from './Toast.module.css'

type Tone = 'neutral' | 'success' | 'danger'
/** 알림 오른쪽의 버튼 (예: 완료 알림의 [보기]) */
type Action = { label: string; onClick: () => void }
type Item = { id: number; message: string; tone: Tone; action?: Action }
type Show = (message: string, tone?: Tone, action?: Action) => void

const DURATION_MS = 4000
const ACTION_DURATION_MS = 8000 // 버튼이 있으면 누를 시간을 더 준다

const ToastContext = createContext<Show | null>(null)

// 앱 맨 바깥에 한 번 둔다. 알림은 오른쪽 아래에 쌓이고 4초(버튼이 있으면 8초) 뒤 사라진다.
export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [items, setItems] = useState<Item[]>([])
  const nextId = useRef(0)

  const dismiss = useCallback((id: number) => setItems((prev) => prev.filter((t) => t.id !== id)), [])

  const show = useCallback<Show>(
    (message, tone = 'neutral', action) => {
      const id = nextId.current++
      setItems((prev) => [...prev, { id, message, tone, action }])
      setTimeout(() => dismiss(id), action ? ACTION_DURATION_MS : DURATION_MS)
    },
    [dismiss]
  )

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className={styles.region} role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx(styles.toast, styles[t.tone])}>
            <span className={styles.message}>{t.message}</span>
            {t.action && (
              <button
                className={styles.action}
                onClick={() => {
                  dismiss(t.id)
                  t.action!.onClick()
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

// const toast = useToast(); toast('노트가 만들어졌어요', 'success')
export function useToast(): Show {
  const show = useContext(ToastContext)
  if (!show) throw new Error('useToast는 ToastProvider 안에서만 쓸 수 있어요')
  return show
}
