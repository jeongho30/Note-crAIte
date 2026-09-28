// 작업 중 트레이: 작업이 있을 때 창을 닫으면 트레이로 숨고, 받아쓰기를 계속한다. 메뉴는 [열기]와 [끝내기]뿐.
import { Menu, nativeImage, Tray } from 'electron'
import type { NativeImage } from 'electron'

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

export function createTray({ open, quit }: { open: () => void; quit: () => void }) {
  let tray: Tray | null = null

  function ensure(): Tray {
    if (tray) return tray
    tray = new Tray(drawIcon())
    tray.setToolTip('lecture-notes')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '열기', click: open },
        { type: 'separator' },
        { label: '끝내기', click: quit }
      ])
    )
    tray.on('click', open)
    tray.on('balloon-click', open)
    return tray
  }

  return {
    ensure,
    exists: () => tray !== null,
    destroy: () => {
      tray?.destroy()
      tray = null
    },
    status: (text: string) => tray?.setToolTip(text),
    // Windows 알림 센터에 뜬다 (앱 알림 등록 없이도 트레이 아이콘으로 보낼 수 있다)
    notify: (title: string, content: string) => ensure().displayBalloon({ title, content, iconType: 'none' })
  }
}
