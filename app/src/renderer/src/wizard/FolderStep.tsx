import { useEffect, useState } from 'react'
import { ApiError, call } from '../api'
import { Banner, Button, TextField } from '../components'
import type { Settings } from '../../../core/settings'
import type { FolderInfo } from '../../../core/vault'
import type { StepProps } from './shared'
import { Step } from './Step'
import styles from './Wizard.module.css'

const MAX_SUBJECTS = 4

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

// 이미 있는 과목 폴더를 보여 주고, 없으면 예시를 보여 준다.
function tree(info: FolderInfo): string {
  const lines = [`${folderName(info.path)}/`]
  if (!info.subjects.length) {
    lines.push('├─ 컴파일러/', '│  └─ 2026-09-21 Lexical Analysis.md', '└─ 자료구조/')
    return lines.join('\n')
  }
  const shown = info.subjects.slice(0, MAX_SUBJECTS)
  const rest = info.subjects.length - shown.length
  shown.forEach((s, i) => lines.push(`${i === shown.length - 1 && !rest ? '└─' : '├─'} ${s}/`))
  if (rest) lines.push(`└─ … 외 ${rest}개`)
  return lines.join('\n')
}

export function FolderStep({ next, back, headingRef }: StepProps): React.JSX.Element {
  const [info, setInfo] = useState<FolderInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function inspect(path: string): Promise<void> {
    setError(null)
    setInfo(await call<FolderInfo>('folder.inspect', path))
  }

  useEffect(() => {
    void (async () => {
      const s = await call<Settings>('settings.get')
      await inspect(s.outDir ?? (await call<string>('folder.default')))
    })()
  }, [])

  async function change(): Promise<void> {
    const picked = await call<string | null>('folder.pick', info?.path)
    if (picked) await inspect(picked)
  }

  async function onNext(): Promise<void> {
    if (!info) return
    setSaving(true)
    try {
      await call('folder.use', info.path)
      next()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '폴더를 만들지 못했어요. 다른 폴더를 골라 주세요.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Step
      title="노트를 저장할 폴더를 골라 주세요"
      headingRef={headingRef}
      actions={
        <>
          <Button variant="ghost" className={styles.back} onClick={back}>
            이전
          </Button>
          <Button variant="primary" size="lg" disabled={!info?.writable || saving} onClick={() => void onNext()}>
            다음
          </Button>
        </>
      }
    >
      <div className={styles.row}>
        <div className={styles.grow}>
          <TextField label="저장 폴더" readOnly value={info?.path ?? ''} />
        </div>
        <Button onClick={() => void change()}>바꾸기</Button>
      </div>

      {info?.vaultRoot && <Banner tone="success">옵시디언 볼트로 인식했어요. 노트가 볼트 안에 과목별로 저장돼요.</Banner>}
      {info && !info.writable && <Banner tone="danger">이 폴더에는 저장할 수 없어요. 다른 폴더를 골라 주세요.</Banner>}
      {error && <Banner tone="danger">{error}</Banner>}

      {info && (
        <>
          <pre className={styles.tree} aria-label="저장 폴더 구조">
            {tree(info)}
          </pre>
          <p className={styles.small}>
            {info.subjects.length ? '이 폴더 안의 하위 폴더가 과목 목록이 돼요. ' : '과목을 고르면 이 폴더 안에 과목 폴더가 생겨요. '}
            녹음 파일은 이 폴더로 복사하지 않고 노트만 저장해요.
          </p>
        </>
      )}
    </Step>
  )
}
