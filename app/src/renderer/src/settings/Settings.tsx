import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, call } from '../api'
import { Button, Dialog, SegmentedControl, useToast } from '../components'
import { PRODUCT_NAME, PRODUCT_NAME_KO, TAGLINE } from '../../../core/brand'
import type { FolderInfo } from '../../../core/vault'
import type { Language, Settings as AppSettings, Theme } from '../../../core/settings'
import { gpuLabel, percent, useSetup, type LlmStatus } from '../wizard/shared'
import { AdvancedSection } from './AdvancedSection'
import { AutoSection } from './AutoSection'
import { Row, Section, SettingsCard, sizeLabel } from './parts'
import { ProviderSection } from './ProviderSection'
import styles from './Settings.module.css'

type Storage = { modelsBytes: number; models: string[]; jobsBytes: number; done: number; stopped: number }
// 과목 없이 저장한 노트가 가는 폴더 이름 (core/note.ts의 saveNote). 과목 목록에는 폴더로 나온다
const UNFILED = '미분류'

type Subjects = { subjects: string[]; subjectLanguage: Record<string, Language> }

const LANGS: { value: Language; label: string }[] = [
  { value: 'ko', label: '한국어' },
  { value: 'en', label: '영어' }
]

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: '시스템' },
  { value: 'light', label: '라이트' },
  { value: 'dark', label: '다크' }
]

const SECTIONS = ['화면', '요약 서비스', '받아쓰기', '과목 · 강의 언어', '저장 폴더', '자동 처리', '저장 공간', '고급', '정보'] as const
type SectionName = (typeof SECTIONS)[number]

const LICENSES: [string, string][] = [
  ['whisper.cpp', 'MIT'],
  ['Whisper 모델 (OpenAI)', 'MIT'],
  ['Silero VAD', 'MIT'],
  ['FFmpeg', 'LGPL 2.1 이상'],
  ['Electron', 'MIT'],
  ['React', 'MIT'],
  ['Pretendard', 'SIL Open Font License 1.1']
]

type Props = {
  llm: LlmStatus | null
  /** 완료한 작업 수 (바뀌면 저장 공간을 다시 잰다) */
  doneCount: number
  /** 홈의 [연결하기]·작업 목록의 [키 다시 넣기]로 들어올 때마다 바뀐다 */
  openKey: number
  onLlmChange: () => void
  onRestartWizard: () => void
}

// 설정: 한 페이지에 묶음을 세로로 쌓고 본문만 스크롤한다. 위의 칩으로 묶음에 건너뛴다.
export function Settings({ llm, doneCount, openKey, onLlmChange, onRestartWizard }: Props): React.JSX.Element {
  const toast = useToast()
  const setup = useSetup()
  const refs = useRef<Partial<Record<SectionName, HTMLElement | null>>>({})
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [folder, setFolder] = useState<FolderInfo | null>(null)
  const [subjects, setSubjects] = useState<Subjects | null>(null)
  const [storage, setStorage] = useState<Storage | null>(null)
  const [version, setVersion] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [allSubjects, setAllSubjects] = useState(false)
  const [licenses, setLicenses] = useState(false)

  const fail = useCallback((e: unknown) => toast(e instanceof ApiError ? e.message : '문제가 생겼어요. 다시 시도해 주세요.', 'danger'), [toast])

  const loadFolder = useCallback(async () => {
    const s = await call<AppSettings>('settings.get')
    setSettings(s)
    if (s.outDir) {
      setFolder(await call<FolderInfo>('folder.inspect', s.outDir))
      setSubjects(await call<Subjects>('subjects.get').catch(() => ({ subjects: [], subjectLanguage: s.subjectLanguage })))
    }
  }, [])

  const loadStorage = useCallback(() => call<Storage>('storage.info').then(setStorage), [])

  useEffect(() => {
    void loadFolder()
    call<{ version: string }>('ping').then((p) => setVersion(p.version))
  }, [loadFolder])

  useEffect(() => {
    void loadStorage()
  }, [loadStorage, doneCount, setup?.model.state, setup?.name])

  // [연결하기]로 들어오면 요약 서비스 묶음을 보인다
  useEffect(() => {
    if (openKey) refs.current['요약 서비스']?.scrollIntoView({ block: 'start' })
  }, [openKey])

  const jump = (name: SectionName): void => refs.current[name]?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  const refFor = (name: SectionName) => (el: HTMLElement | null) => {
    refs.current[name] = el
  }

  async function setLanguage(subject: string, language: Language): Promise<void> {
    try {
      const subjectLanguage = await call<Record<string, Language>>('settings.setSubjectLanguage', { subject, language })
      setSubjects((s) => (s ? { ...s, subjectLanguage } : s))
    } catch (e) {
      fail(e)
    }
  }

  async function setTheme(theme: Theme): Promise<void> {
    setSettings((s) => (s ? { ...s, theme } : s))
    try {
      await call('settings.setTheme', theme)
    } catch (e) {
      fail(e)
    }
  }

  async function changeFolder(): Promise<void> {
    try {
      const path = await call<string | null>('folder.pick', settings?.outDir ?? undefined)
      if (!path) return
      await call('folder.use', path)
      await loadFolder()
      toast('저장 폴더를 바꿨어요. 새 노트부터 이 폴더에 저장돼요.', 'success')
    } catch (e) {
      fail(e)
    }
  }

  async function clearDone(): Promise<void> {
    setConfirmClear(false)
    try {
      const n = await call<number>('jobs.clearDone')
      toast(`완료한 작업 기록 ${n}개를 지웠어요.`, 'success')
      await loadStorage()
    } catch (e) {
      fail(e)
    }
  }

  async function reprobe(): Promise<void> {
    try {
      await call('setup.reprobe')
    } catch (e) {
      fail(e)
    }
  }

  // ── 받아쓰기 줄 ──
  let sttTitle = '이 PC의 받아쓰기를 확인하는 중이에요'
  let sttSub = ''
  if (setup) {
    const { model, probe } = setup
    if (model.state === 'downloading') {
      sttTitle = `받아쓰기 모델 받는 중 ${percent(model.done, model.total)}%`
      sttSub = '다 받으면 이 PC의 속도를 다시 재요'
    } else if (model.state !== 'ready') {
      sttTitle = '받아쓰기 모델을 아직 받지 않았어요'
      sttSub = model.error ?? `${sizeLabel(model.total)} · 처음 한 번만 받아요`
    } else if (probe.state === 'running') {
      sttTitle = '이 PC의 받아쓰기 속도를 재는 중이에요'
      sttSub = '1분쯤 걸려요'
    } else if (probe.state === 'done') {
      sttTitle = probe.gpuName ? `그래픽카드(${gpuLabel(probe.gpuName)})로 받아써요` : '이 PC의 프로세서로 받아써요'
      sttSub = `90분 강의 약 ${probe.minutesFor90}분${probe.gpuName ? '' : ' · 처리는 뒤에서 진행돼요'}`
    } else if (probe.state === 'error') {
      sttTitle = '속도를 재지 못했어요 · 프로세서로 받아써요'
      sttSub = probe.error ?? ''
    } else {
      sttTitle = '작업이 끝나면 이 PC의 속도를 다시 재요'
    }
  }
  const modelMissing = setup && (setup.model.state === 'missing' || setup.model.state === 'error')

  const langOf = (s: string): Language => subjects?.subjectLanguage[s] ?? 'ko'

  return (
    <div className={styles.settings}>
      <div className={styles.head}>
        <h1>설정</h1>
        <nav className={styles.jump} aria-label="설정 묶음">
          {SECTIONS.map((s) => (
            <button key={s} onClick={() => jump(s)}>
              {s}
            </button>
          ))}
        </nav>
      </div>

      <Section ref={refFor('화면')} title="화면">
        <SettingsCard>
          <Row
            title="색 모드"
            sub="시스템은 Windows의 라이트·다크 설정을 따라요"
            ctrl={<SegmentedControl label="색 모드" value={settings?.theme ?? 'system'} options={THEMES} onChange={(t) => void setTheme(t)} />}
          />
        </SettingsCard>
      </Section>

      <ProviderSection ref={refFor('요약 서비스')} llm={llm} openKey={openKey} onChange={onLlmChange} />

      <Section ref={refFor('받아쓰기')} title="받아쓰기" hint="모델과 명령 옵션은 고급 > 받아쓰기 세부설정에서 바꿔요.">
        <SettingsCard>
          <Row
            title={sttTitle}
            sub={sttSub}
            ctrl={
              modelMissing ? (
                <Button size="sm" variant="primary" onClick={() => void call('setup.download')}>
                  {setup.model.done > 0 ? '이어 받기' : '받기 시작'}
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={setup?.model.state !== 'ready' || setup.probe.state === 'running'}
                  onClick={() => void reprobe()}
                >
                  속도 다시 재기
                </Button>
              )
            }
          />
          <Row
            title="받아쓰기 모델"
            sub={setup ? `${setup.name}${setup.name === 'large-v3-turbo-q8_0' ? ' (기본)' : ''} · ${sizeLabel(setup.model.total)}` : ''}
          />
        </SettingsCard>
      </Section>

      <Section
        ref={refFor('과목 · 강의 언어')}
        title="과목 · 강의 언어"
        hint="시작 전 확인에서 이 언어가 먼저 골라져요. 거기서 언어를 바꿔 시작하면 여기에도 저장돼요. 새 과목은 한국어예요. 과목은 저장 폴더의 하위 폴더예요."
      >
        <SettingsCard>
          {subjects && subjects.subjects.length > 0 ? (
            <>
              {/* 과목이 3개 이상이면 처음엔 하나만 보이고 [과목 N개 더 보기]로 펼친다(접힘 상태는 저장하지 않음). 그 하나는 미분류가 아닌 첫 과목 */}
              {(subjects.subjects.length >= 3 && !allSubjects ? [subjects.subjects.find((s) => s !== UNFILED) ?? subjects.subjects[0]] : subjects.subjects).map((s) => (
                <Row
                  key={s}
                  title={s}
                  ctrl={<SegmentedControl label={`${s} 강의 언어`} value={langOf(s)} options={LANGS} onChange={(l) => void setLanguage(s, l)} />}
                />
              ))}
              {subjects.subjects.length >= 3 && (
                <button
                  type="button"
                  className={styles.more}
                  aria-expanded={allSubjects}
                  aria-label={allSubjects ? '과목 접기' : undefined}
                  onClick={() => setAllSubjects(!allSubjects)}
                >
                  {allSubjects ? (
                    <span className={styles.up} aria-hidden="true" />
                  ) : (
                    <>
                      과목 {subjects.subjects.length - 1}개 더 보기<span className={styles.down} aria-hidden="true" />
                    </>
                  )}
                </button>
              )}
            </>
          ) : (
            <p className={styles.empty}>아직 과목 폴더가 없어요. 녹음을 넣을 때 새 과목을 만들면 여기에 보여요.</p>
          )}
        </SettingsCard>
      </Section>

      <Section ref={refFor('저장 폴더')} title="저장 폴더" hint="바꾸면 새 노트부터 그 폴더에 저장돼요. 이미 만든 노트는 옮기지 않아요.">
        <SettingsCard>
          <Row
            title={settings?.outDir ?? '저장 폴더가 정해지지 않았어요'}
            sub={folder ? [folder.vaultRoot ? '옵시디언 볼트 안이에요' : null, `과목 ${folder.subjects.length}개`].filter(Boolean).join(' · ') : ''}
            ctrl={
              <>
                <Button size="sm" onClick={() => void changeFolder()}>
                  바꾸기
                </Button>
                {settings?.outDir && (
                  <Button size="sm" variant="ghost" onClick={() => void call('folder.openOut').catch(fail)}>
                    폴더 열기
                  </Button>
                )}
              </>
            }
          />
        </SettingsCard>
      </Section>

      <AutoSection ref={refFor('자동 처리')} />

      <Section ref={refFor('저장 공간')} title="저장 공간">
        <SettingsCard>
          <Row
            title="받아쓰기 모델"
            sub={
              !storage ? '' : storage.models.length ? `${sizeLabel(storage.modelsBytes)} · ${storage.models.join(', ')}, 음성 구간 감지 모델` : '받은 모델이 없어요'
            }
          />
          <Row
            title="작업 기록"
            sub={storage ? [sizeLabel(storage.jobsBytes), `완료 ${storage.done}개`, storage.stopped ? `멈춘 작업 ${storage.stopped}개` : null].filter(Boolean).join(' · ') : ''}
            ctrl={
              <Button size="sm" variant="outline" disabled={!storage?.done} onClick={() => setConfirmClear(true)}>
                완료한 작업 기록 지우기
              </Button>
            }
          />
        </SettingsCard>
      </Section>

      <AdvancedSection ref={refFor('고급')} setup={setup} connected={!!llm?.provider} onSaved={() => void loadStorage()} onStepsSaved={onLlmChange} />

      <Section ref={refFor('정보')} title="정보">
        <SettingsCard>
          <Row
            title={`${PRODUCT_NAME} ${version}`}
            sub={`${PRODUCT_NAME_KO} · ${TAGLINE}`}
            ctrl={
              <Button variant="link" onClick={() => void call('app.openReleases')}>
                새 버전 보기 (GitHub)
              </Button>
            }
          />
          <Row
            title="데이터 폴더"
            sub="%LOCALAPPDATA%\lecture-notes · 모델, 작업 기록, 로그"
            ctrl={
              <>
                <Button size="sm" variant="ghost" onClick={() => void call('app.openData').catch(fail)}>
                  데이터 폴더 열기
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void call('app.openLogs').catch(fail)}>
                  로그 폴더 열기
                </Button>
              </>
            }
          />
          <Row
            title="첫 실행 마법사"
            sub="요약 서비스·저장 폴더를 처음부터 다시 정해요"
            ctrl={
              <Button size="sm" variant="ghost" onClick={onRestartWizard}>
                다시 보기
              </Button>
            }
          />
          <Row
            title="오픈소스 라이선스"
            sub="whisper.cpp, ffmpeg(LGPL), Pretendard(OFL) 등"
            ctrl={
              <Button size="sm" variant="ghost" onClick={() => setLicenses(true)}>
                보기
              </Button>
            }
          />
        </SettingsCard>
      </Section>

      <Dialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title={`완료한 작업 기록 ${storage?.done ?? 0}개를 지울까요?`}
        actions={
          <>
            <Button onClick={() => setConfirmClear(false)}>취소</Button>
            <Button variant="danger" onClick={() => void clearDone()}>
              지우기
            </Button>
          </>
        }
      >
        <p className={styles.dialogText}>작업 목록의 "완료"에서 빠져요. 만든 노트와 원래 녹음은 그대로예요. 되돌릴 수 없어요.</p>
      </Dialog>

      <Dialog
        open={licenses}
        onClose={() => setLicenses(false)}
        title="오픈소스 라이선스"
        actions={
          <>
            <Button variant="ghost" onClick={() => void call('app.openNotices').catch(fail)}>
              전체 고지 보기
            </Button>
            <Button onClick={() => setLicenses(false)}>닫기</Button>
          </>
        }
      >
        <ul className={styles.licenses}>
          {LICENSES.map(([name, license]) => (
            <li key={name}>
              <b>{name}</b> · {license}
            </li>
          ))}
        </ul>
        <p className={styles.dialogText}>{PRODUCT_NAME}는 MIT 라이선스예요.</p>
      </Dialog>
    </div>
  )
}
