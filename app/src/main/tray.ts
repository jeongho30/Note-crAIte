// 트레이: 작업 중이거나 자동 처리가 켜져 있으면 창을 닫아도 트레이에 남아 일을 계속한다. 메뉴는 진행 상황·창 열기·자동 처리 멈추기·끝내기.
import { Menu, nativeImage, Tray } from 'electron'
import type { NativeImage } from 'electron'
import { PRODUCT_NAME } from '../core/brand.ts'

const SIZE = 32 // 트레이는 16 DIP. 2배로 그려 고해상도 화면에서도 선명하게
const TEAL = [0x34, 0x65, 0x6d] // --color-primary (라이트)
const BARS = [10, 18, 26, 14, 22] // 홈 끌어 놓기 칸의 파형과 같은 모양

// 앱 아이콘을 정하기 전까지 쓰는 트레이 아이콘: 주색 둥근 사각형에 흰 파형
function drawIcon(): NativeImage {
  const buf = Buffer.alloc(SIZE * SIZE * 4) // BGRA
  const r = 7
  const set = (x: number, y: number, [red, green, blue]: number[]): void => {
    const i = (y * SIZE + x) * 4
    buf[i] = blue
    buf[i + 1] = green
    buf[i + 2] = red
    buf[i + 3] = 255
  }
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = Math.max(r - x, x - (SIZE - 1 - r), 0)
      const dy = Math.max(r - y, y - (SIZE - 1 - r), 0)
      if (dx * dx + dy * dy <= r * r) set(x, y, TEAL)
    }
  }
  const barW = 3
  const gap = 2
  const left = Math.round((SIZE - (BARS.length * barW + (BARS.length - 1) * gap)) / 2)
  BARS.forEach((h, i) => {
    const height = Math.round((h / 26) * 20)
    const top = Math.round((SIZE - height) / 2)
    for (let y = top; y < top + height; y++) {
      for (let x = 0; x < barW; x++) set(left + i * (barW + gap) + x, y, [255, 255, 255])
    }
  })
  return nativeImage.createFromBitmap(buf, { width: SIZE, height: SIZE, scaleFactor: 2 })
}

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

export function createTray(actions: Actions) {
  let tray: Tray | null = null
  let onBalloon: (() => void) | null = null // 마지막 알림을 눌렀을 때 (없으면 창만 연다)
  let state: TrayState = { lines: [], watch: 'off' }

  function ensure(): Tray {
    if (tray) return tray
    tray = new Tray(drawIcon())
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
