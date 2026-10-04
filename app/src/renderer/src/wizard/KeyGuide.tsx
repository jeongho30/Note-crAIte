import { useState } from 'react'
import { call } from '../api'
import { Button, Dialog } from '../components'
import menu from '../assets/keyguide/chatkhu-1-menu.png'
import create from '../assets/keyguide/chatkhu-2-create.png'
import name from '../assets/keyguide/chatkhu-3-name.png'
import styles from './Wizard.module.css'

// ChatKHU 화면을 잘라 온 그림 (10/4). width는 화면에 보일 폭
const CHATKHU_STEPS: { text: React.ReactNode; image?: { src: string; width: number; alt: string } }[] = [
  {
    text: (
      <>
        ChatKHU(chat.khu.ac.kr)에 경희대 계정으로 로그인하고, 왼쪽 메뉴 맨 아래의 <b>API Gateway</b>를 눌러요.
      </>
    ),
    image: { src: menu, width: 240, alt: 'ChatKHU 왼쪽 메뉴 맨 아래의 API Gateway' }
  },
  {
    text: (
      <>
        화면을 아래로 내려 "API 키 관리"의 <b>API 키 생성</b>을 눌러요.
      </>
    ),
    image: { src: create, width: 420, alt: 'API 키 관리 오른쪽의 API 키 생성 버튼' }
  },
  {
    text: (
      <>
        이름(예: Note-crAIte)을 적고 <b>생성하기</b>를 눌러요. 설명은 비워 둬도 돼요.
      </>
    ),
    image: { src: name, width: 260, alt: '이름과 설명을 적는 API 키 생성 창' }
  },
  { text: '만들어진 키를 복사해 이 앱의 키 칸에 붙여 넣고 [확인]을 눌러요. 목록에서는 키가 가려져 보이니 만든 직후에 복사해 두세요.' }
]

// [키 발급 방법 보기]: ChatKHU는 그림으로 단계를 보여 주고, 다른 서비스는 키 발급 페이지를 연다.
// primary: 마법사에서 키가 아직 없을 때 주 버튼으로 보인다
export function KeyGuideLink({ provider, primary }: { provider: string; primary?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const openSite = (): void => void call('llm.openKeyGuide', provider)

  return (
    <>
      <Button variant={primary ? 'primary' : 'link'} size={primary ? 'lg' : undefined} onClick={provider === 'chatkhu' ? () => setOpen(true) : openSite}>
        키 발급 방법 보기
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="ChatKHU 키 발급 방법"
        size="lg"
        actions={
          <>
            <Button onClick={() => setOpen(false)}>닫기</Button>
            <Button variant="primary" onClick={openSite}>
              ChatKHU 키 화면 열기
            </Button>
          </>
        }
      >
        <ol className={styles.guide}>
          {CHATKHU_STEPS.map((s, i) => (
            <li key={i}>
              {s.text}
              {s.image && <img className={styles.shot} src={s.image.src} width={s.image.width} alt={s.image.alt} />}
            </li>
          ))}
        </ol>
      </Dialog>
    </>
  )
}
