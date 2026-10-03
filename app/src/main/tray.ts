// 트레이: 작업 중이거나 자동 처리가 켜져 있으면 창을 닫아도 트레이에 남아 일을 계속한다. 메뉴는 진행 상황·창 열기·자동 처리 멈추기·끝내기.
import { Menu, Tray } from 'electron'
import { PRODUCT_NAME } from '../core/brand.ts'

export type TrayState = {
  /** 메뉴 맨 위에 보이는 진행 상황 (예: "9.21 컴파일러.m4a · 받아쓰기 42%", "폴더 감시 중") */
  lines: string[]
  /** 자동 처리 상태: 켜져 있을 때만 [멈추기]/[다시 시작]이 보인다 */
  watch: 'off' | 'on' | 'paused'
}

type Actions = { open: () => void; quit: () => void; toggleWatch: () => void }

// 트레이 메뉴: 진행 상황, 창 열기, 자동 처리 멈추기/다시 시작, 끝내기 (화면 흐름 초안)
function buildMenu(state: TrayState, a: Actions): Menu {
  return Menu.buildFromTemplate([
    ...state.lines.map((label) => ({ label, enabled: false })),
    ...(state.lines.length ? [{ type: 'separator' as const }] : []),
    { label: '창 열기', click: a.open },
    ...(state.watch === 'off' ? [] : [{ label: state.watch === 'paused' ? '자동 처리 다시 시작' : '자동 처리 멈추기', click: a.toggleWatch }]),
    { type: 'separator' },
    { label: '끝내기', click: a.quit }
  ])
}

export function createTray(icon: string, actions: Actions) {
  let tray: Tray | null = null
  let onBalloon: (() => void) | null = null // 마지막 알림을 눌렀을 때 (없으면 창만 연다)
  let state: TrayState = { lines: [], watch: 'off' }

  function ensure(): Tray {
    if (tray) return tray
    tray = new Tray(icon)
    tray.setToolTip(PRODUCT_NAME)
    tray.setContextMenu(buildMenu(state, actions))
    tray.on('click', actions.open)
    tray.on('balloon-click', () => (onBalloon ?? actions.open)())
    return tray
  }

  return {
    ensure,
    exists: () => tray !== null,
    destroy: () => {
      tray?.destroy()
      tray = null
    },
    /** 마우스를 올렸을 때 보이는 글과 메뉴를 바꾼다 */
    update: (next: TrayState) => {
      state = next
      if (!tray) return
      tray.setToolTip([PRODUCT_NAME, ...next.lines].join('\n').slice(0, 127)) // Windows 툴팁은 127자까지
      tray.setContextMenu(buildMenu(next, actions))
    },
    // Windows 알림 센터에 뜬다 (앱 알림 등록 없이도 트레이 아이콘으로 보낼 수 있다)
    notify: (title: string, content: string, onClick?: () => void) => {
      onBalloon = onClick ?? null
      ensure().displayBalloon({ title, content, iconType: 'none' })
    }
  }
}
