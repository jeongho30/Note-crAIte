import { useState } from 'react'
import {
  Banner,
  Button,
  Card,
  Dialog,
  ListRow,
  ProgressBar,
  RadioCardGroup,
  SegmentedControl,
  Select,
  StatusPill,
  Stepper,
  TextField,
  useToast
} from './components'
import styles from './ComponentGallery.module.css'

// 기본 부품 모음. W2 화면이 생기기 전까지 부품을 눈으로 확인하는 자리다.
export default function ComponentGallery(): React.JSX.Element {
  const toast = useToast()
  const [lang, setLang] = useState<'ko' | 'en'>('ko')
  const [stt, setStt] = useState<'local' | 'chatkhu'>('local')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [progress, setProgress] = useState(0.42)

  return (
    <div className={styles.gallery}>
      <section className={styles.section}>
        <h2 className={styles.heading}>버튼</h2>
        <div className={styles.row}>
          <Button variant="primary">시작</Button>
          <Button>파일 고르기</Button>
          <Button variant="ghost">취소</Button>
          <Button variant="danger">삭제</Button>
          <Button variant="primary" disabled>
            비활성
          </Button>
        </div>
        <div className={styles.row}>
          <Button size="sm">작게</Button>
          <Button variant="primary" size="lg">
            다음
          </Button>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>입력</h2>
        <div className={styles.fields}>
          <TextField label="과목" placeholder="예: 컴파일러" hint="노트가 이 이름의 폴더에 저장돼요." />
          <TextField label="ChatKHU 키" placeholder="키를 붙여 넣어 주세요" error="키가 맞지 않아요. ChatKHU에서 키를 다시 복사해 붙여 넣어 주세요." />
          <Select label="저장 폴더" defaultValue="vault">
            <option value="vault">옵시디언 보관함</option>
            <option value="docs">문서</option>
          </Select>
        </div>
        <SegmentedControl
          label="강의 언어"
          value={lang}
          onChange={setLang}
          options={[
            { value: 'ko', label: '한국어' },
            { value: 'en', label: '영어' }
          ]}
        />
        <RadioCardGroup
          label="받아쓰기 방식"
          value={stt}
          onChange={setStt}
          options={[
            { value: 'local', title: '이 PC에서', description: '녹음이 PC 밖으로 나가지 않아요.', meta: '약 27분' },
            { value: 'chatkhu', title: 'ChatKHU로', description: '빠르지만 크레딧을 써요.', meta: '약 540크레딧' }
          ]}
        />
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>상태와 진행</h2>
        <div className={styles.row}>
          <StatusPill>컴파일러</StatusPill>
          <StatusPill tone="progress">받아쓰기 42%</StatusPill>
          <StatusPill tone="waiting">대기</StatusPill>
          <StatusPill tone="success">완료</StatusPill>
          <StatusPill tone="warning">배터리</StatusPill>
          <StatusPill tone="danger">요약 실패</StatusPill>
        </div>
        <ProgressBar value={progress} label="받아쓰기 진행" />
        <div className={styles.row}>
          <Button size="sm" onClick={() => setProgress((p) => (p >= 1 ? 0 : Math.min(1, p + 0.2)))}>
            진행 +20%
          </Button>
        </div>
        <Banner tone="warning" title="주의">
          배터리로 동작 중이에요. 전원을 연결하면 더 빨라요.
        </Banner>
        <Banner tone="danger" title="실패" action={<Button size="sm">전사만 저장</Button>}>
          크레딧이 부족해요.
        </Banner>
        <Banner tone="success" title="완료">
          노트가 만들어졌어요 · 컴파일러
        </Banner>
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>목록과 틀</h2>
        <Card>
          <ListRow
            title="9.21 compiler.m4a"
            description="2026-09-21 · 1시간 3분"
            meta={<StatusPill tone="progress">받아쓰기 42%</StatusPill>}
            actions={
              <Button size="sm" variant="ghost">
                취소
              </Button>
            }
          />
          <ListRow title="9.14 Lexical Analysis.m4a" description="2026-09-14 · 1시간 12분" meta={<StatusPill tone="success">완료</StatusPill>} selected />
          <ListRow
            title="9.7 intro.m4a"
            description="2026-09-07 · 58분"
            meta={<StatusPill tone="danger">요약 실패</StatusPill>}
            actions={<Button size="sm">이어서 다시 시도</Button>}
          />
        </Card>
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>떠 있는 층</h2>
        <div className={styles.row}>
          <Button onClick={() => setDialogOpen(true)}>대화상자 열기</Button>
          <Button onClick={() => toast('노트가 만들어졌어요 · 컴파일러', 'success')}>알림 띄우기</Button>
          <Button onClick={() => toast('요약에 실패했어요. 작업 목록에서 다시 시도할 수 있어요.', 'danger')}>실패 알림</Button>
        </div>
        <Dialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          title="이 작업을 지울까요?"
          actions={
            <>
              <Button onClick={() => setDialogOpen(false)}>취소</Button>
              <Button variant="danger" onClick={() => setDialogOpen(false)}>
                지우기
              </Button>
            </>
          }
        >
          만들어진 노트는 지워지지 않아요.
        </Dialog>
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>마법사 단계</h2>
        <Stepper steps={['안내', '이 PC 확인', 'ChatKHU 키', '저장 폴더']} current={1} />
      </section>
    </div>
  )
}
