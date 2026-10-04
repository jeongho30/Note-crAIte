import { forwardRef, useEffect, useState } from 'react'
import { ApiError, call } from '../api'
import { Banner, Button, Checkbox, Dialog, SegmentedControl, useToast } from '../components'
import type { WatchStatus } from '../../../main/watcher'
import { Row, Section, SettingsCard } from './parts'
import styles from './Settings.module.css'

type Status = WatchStatus & { login: { supported: boolean; openAtLogin: boolean } }
type Inspect = { existing: number; missingSubjects: string[]; insideOut: boolean }
type Draft = { folder: string; inspect: Inspect; createSubjects: boolean; processExisting: boolean; openAtLogin: boolean }

const ON_OFF: { value: 'on' | 'off'; label: string }[] = [
  { value: 'on', label: '켬' },
  { value: 'off', label: '끔' }
]

// 설정 > 자동 처리: 감시 폴더에 녹음을 넣으면 확인 없이 노트를 만든다. 켜기는 폴더를 고른 뒤 확인 창에서 한다(화면 흐름 초안).
export const AutoSection = forwardRef<HTMLElement>(function AutoSection(_props, ref) {
  const toast = useToast()
  const [status, setStatus] = useState<Status | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const off = window.api.on('watch', (d) => setStatus(d as Status))
    call<Status>('watch.get').then((s) => alive && setStatus(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  const fail = (e: unknown): void => toast(e instanceof ApiError ? e.message : '하지 못했어요. 다시 시도해 주세요.', 'danger')

  async function run(method: string, params?: unknown): Promise<void> {
    setBusy(true)
    try {
      setStatus(await call<Status>(method, params))
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  // [켜기…]·[다른 폴더]: 폴더를 고르고, 확인 창에 보여 줄 것을 읽는다
  async function pickFolder(): Promise<void> {
    try {
      const folder = await call<string | null>('folder.pick', draft?.folder ?? status?.folder ?? undefined)
      if (!folder) return
      const inspect = await call<Inspect>('watch.inspect', folder)
      setDraft({
        folder,
        inspect,
        createSubjects: inspect.missingSubjects.length > 0,
        processExisting: false,
        openAtLogin: !!status?.login.supported
      })
    } catch (e) {
      fail(e)
    }
  }

  async function enable(): Promise<void> {
    if (!draft) return
    setBusy(true)
    try {
      setStatus(
        await call<Status>('watch.enable', {
          folder: draft.folder,
          createSubjects: draft.createSubjects ? draft.inspect.missingSubjects : [],
          processExisting: draft.processExisting,
          openAtLogin: draft.openAtLogin
        })
      )
      setDraft(null)
      toast('자동 처리를 켰어요. 폴더에 녹음을 넣으면 노트를 만들어요.', 'success')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const on = !!status?.enabled
  const login = status?.login
  const sub = !status
    ? ''
    : !on
      ? '정한 폴더에 녹음을 넣으면 확인 없이 노트를 만들어요. 하위 폴더 이름이 과목이 돼요.'
      : [status.folder, status.paused ? '멈춤' : status.waiting ? `복사가 끝나기를 기다리는 녹음 ${status.waiting}개` : null]
          .filter(Boolean)
          .join(' · ')

  return (
    <Section
      ref={ref}
      title="자동 처리"
      hint={on ? '노트를 만든 녹음은 그 폴더의 "처리됨"으로 옮겨요. 창을 닫아도 트레이에서 계속 살펴요.' : undefined}
    >
      <SettingsCard>
        <Row
          title={!on ? '폴더 감시' : status?.paused ? '자동 처리 멈춤' : '폴더 감시 중'}
          sub={sub}
          ctrl={
            !on ? (
              <Button size="sm" disabled={!status || busy} onClick={() => void pickFolder()}>
                켜기…
              </Button>
            ) : (
              <>
                <Button size="sm" variant="ghost" onClick={() => void call('watch.openFolder').catch(fail)}>
                  폴더 열기
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void run('watch.pause', !status?.paused)}>
                  {status?.paused ? '다시 시작' : '멈추기'}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run('watch.disable')}>
                  끄기
                </Button>
              </>
            )
          }
        />
        {on && status?.error && (
          <div className={styles.block}>
            <Banner tone="warning">{status.error}</Banner>
          </div>
        )}
        <Row
          title="PC를 켜면 자동으로 실행"
          sub={
            !login?.supported
              ? '설치한 앱에서만 쓸 수 있어요'
              : on
                ? '창 없이 트레이에서 시작해 폴더를 살펴요'
                : '폴더 감시를 켠 경우에만 필요해요'
          }
          dim={!on || !login?.supported}
          ctrl={
            <SegmentedControl
              label="PC를 켜면 자동으로 실행"
              value={login?.openAtLogin ? 'on' : 'off'}
              options={ON_OFF}
              disabled={!on || !login?.supported || busy}
              onChange={(v) => void run('watch.setOpenAtLogin', v === 'on')}
            />
          }
        />
      </SettingsCard>

      <Dialog
        open={!!draft}
        onClose={() => setDraft(null)}
        title="자동 처리 켜기"
        size="lg"
        actions={
          <>
            <Button onClick={() => setDraft(null)}>취소</Button>
            <Button variant="primary" disabled={busy} onClick={() => void enable()}>
              켜기
            </Button>
          </>
        }
      >
        {draft && (
          <div className={styles.autoDialog}>
            <div className={styles.autoFolder}>
              <span className={styles.fieldLabel}>감시할 폴더</span>
              <span className={styles.autoPath}>{draft.folder}</span>
              <Button variant="link" onClick={() => void pickFolder()}>
                다른 폴더
              </Button>
            </div>
            {draft.inspect.insideOut && (
              <Banner tone="warning" title="저장 폴더와 겹쳐요">
                녹음이 노트 폴더(옵시디언 볼트)에 쌓이지 않게 다른 폴더를 권해요.
              </Banner>
            )}
            <p className={styles.dialogText}>
              하위 폴더 이름이 과목이 되고, 강의 언어는 과목 기본값을 써요. 바로 아래에 넣은 녹음은 미분류로 저장해요. 같은 이름의 필기(.md·.txt·.pdf)도 함께 써요. 노트를 만든 녹음은 그 폴더의 "처리됨"으로 옮겨요.
            </p>
            {draft.inspect.missingSubjects.length > 0 && (
              <Checkbox
                checked={draft.createSubjects}
                onChange={(createSubjects) => setDraft({ ...draft, createSubjects })}
                label={`저장 폴더의 과목 ${draft.inspect.missingSubjects.length}개를 감시 폴더에도 만들기`}
                hint={draft.inspect.missingSubjects.join(', ')}
              />
            )}
            {draft.inspect.existing > 0 && (
              <div className={styles.field}>
                <span className={styles.fieldLabel}>폴더에 이미 있는 녹음 {draft.inspect.existing}개</span>
                <SegmentedControl
                  label="이미 있는 녹음"
                  value={draft.processExisting ? 'all' : 'new'}
                  options={[
                    { value: 'new', label: '새 녹음만' },
                    { value: 'all', label: `${draft.inspect.existing}개도 처리하기` }
                  ]}
                  onChange={(v) => setDraft({ ...draft, processExisting: v === 'all' })}
                />
              </div>
            )}
            <Checkbox
              checked={draft.openAtLogin}
              disabled={!status?.login.supported}
              onChange={(openAtLogin) => setDraft({ ...draft, openAtLogin })}
              label="PC를 켜면 자동으로 실행"
              hint={status?.login.supported ? '창 없이 트레이에서 시작해 폴더를 살펴요' : '설치한 앱에서만 쓸 수 있어요'}
            />
            <p className={styles.hint}>창을 닫아도 트레이(작업 표시줄 오른쪽 아이콘)에서 계속 살펴요. 트레이 메뉴에서 잠시 멈출 수 있어요.</p>
          </div>
        )}
      </Dialog>
    </Section>
  )
})
