// 앱 아이콘(resources/icon.ico)을 만든다. 모양을 고칠 때만 돌리고 결과 파일을 커밋한다: node scripts/icon.mjs
// 크림색 바탕에 청록 테두리, 왼쪽은 파형·오른쪽은 글줄(소리가 글이 됨), 가운데 줄만 워드마크의 빨강. 모두 둥근 사각형이라 직접 그린다.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'

const OUT = join(import.meta.dirname, '..', 'resources', 'icon.ico')
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
const SS = 8 // 픽셀 하나를 8×8로 나눠 가장자리를 부드럽게

const TEAL = [0x34, 0x65, 0x6d]
const CREAM = [0xfa, 0xf8, 0xf1]
const RED = [0x99, 0x0e, 0x17]
// 120×120 기준 [x, y, 너비, 높이, 모서리 반지름, 색]. 아래로 갈수록 위에 그려진다
const SHAPES = [
  [0, 0, 120, 120, 26, TEAL],
  [8, 8, 104, 104, 18, CREAM],
  [20, 48, 8, 24, 4, TEAL],
  [34, 32, 8, 56, 4, TEAL],
  [48, 42, 8, 36, 4, TEAL],
  [64, 38, 38, 8, 4, TEAL],
  [64, 56, 38, 8, 4, RED],
  [64, 74, 24, 8, 4, TEAL]
]

// 작은 크기는 줄이면 막대가 뭉개져서 픽셀에 맞춘 그림을 따로 둔다 (기준이 그 크기 그대로)
const SMALL = {
  16: [
    [0, 0, 16, 16, 3.5, TEAL],
    [1, 1, 14, 14, 2.5, CREAM],
    [3, 6, 1, 4, 0, TEAL],
    [5, 4, 1, 8, 0, TEAL],
    [7, 5, 1, 6, 0, TEAL],
    [9, 5, 4, 1, 0, TEAL],
    [9, 7, 4, 2, 0, RED],
    [9, 10, 3, 1, 0, TEAL]
  ],
  20: [
    [0, 0, 20, 20, 4.5, TEAL],
    [2, 2, 16, 16, 3, CREAM],
    [4, 8, 2, 4, 0, TEAL],
    [7, 5, 2, 10, 0, TEAL],
    [10, 7, 2, 6, 0, TEAL],
    [13, 6, 4, 2, 0, TEAL],
    [13, 9, 4, 2, 0, RED],
    [13, 12, 3, 2, 0, TEAL]
  ],
  24: [
    [0, 0, 24, 24, 5.5, TEAL],
    [2, 2, 20, 20, 3.5, CREAM],
    [4, 9, 2, 6, 1, TEAL],
    [7, 6, 2, 12, 1, TEAL],
    [10, 8, 2, 8, 1, TEAL],
    [13, 7, 7, 2, 1, TEAL],
    [13, 11, 7, 2, 1, RED],
    [13, 15, 5, 2, 1, TEAL]
  ]
}

function inside([x, y, w, h, r], px, py) {
  const dx = Math.max(x + r - px, px - (x + w - r), 0)
  const dy = Math.max(y + r - py, py - (y + h - r), 0)
  return px >= x && px <= x + w && py >= y && py <= y + h && dx * dx + dy * dy <= r * r
}

/** size×size RGBA (곱하지 않은 알파) */
function render(size) {
  const buf = Buffer.alloc(size * size * 4)
  const shapes = SMALL[size] ?? SHAPES
  const step = (SMALL[size] ? size : 120) / size / SS
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x * SS + sx + 0.5) * step
          const py = (y * SS + sy + 0.5) * step
          const top = shapes.findLast((s) => inside(s, px, py))
          if (!top) continue
          r += top[5][0]
          g += top[5][1]
          b += top[5][2]
          a++
        }
      }
      if (!a) continue
      const i = (y * size + x) * 4
      buf[i] = Math.round(r / a)
      buf[i + 1] = Math.round(g / a)
      buf[i + 2] = Math.round(b / a)
      buf[i + 3] = Math.round((a / (SS * SS)) * 255)
    }
  }
  return buf
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(size, 0)
  head.writeUInt32BE(size, 4)
  head.set([8, 6, 0, 0, 0], 8) // 8비트 RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// 256 미만은 옛 도구도 읽는 32비트 BMP(아래에서 위로, BGRA, 뒤에 빈 AND 마스크)로 넣는다
function bmp(size, rgba) {
  const head = Buffer.alloc(40)
  head.writeUInt32LE(40, 0)
  head.writeInt32LE(size, 4)
  head.writeInt32LE(size * 2, 8)
  head.writeUInt16LE(1, 12)
  head.writeUInt16LE(32, 14)
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4
      const d = ((size - 1 - y) * size + x) * 4
      pixels[d] = rgba[s + 2]
      pixels[d + 1] = rgba[s + 1]
      pixels[d + 2] = rgba[s]
      pixels[d + 3] = rgba[s + 3]
    }
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size)
  return Buffer.concat([head, pixels, mask])
}

const images = SIZES.map((size) => {
  const rgba = render(size)
  return { size, data: size >= 256 ? png(size, rgba) : bmp(size, rgba) }
})
const dir = Buffer.alloc(6 + images.length * 16)
dir.writeUInt16LE(1, 2) // 아이콘
dir.writeUInt16LE(images.length, 4)
let offset = dir.length
images.forEach(({ size, data }, i) => {
  const e = 6 + i * 16
  dir[e] = size % 256 // 256은 0으로 적는다
  dir[e + 1] = size % 256
  dir.writeUInt16LE(1, e + 4)
  dir.writeUInt16LE(32, e + 6)
  dir.writeUInt32LE(data.length, e + 8)
  dir.writeUInt32LE(offset, e + 12)
  offset += data.length
})
writeFileSync(OUT, Buffer.concat([dir, ...images.map((i) => i.data)]))
console.log(`${OUT} (${SIZES.join(', ')}px)`)

// macOS 메뉴 막대 아이콘 (.ico를 못 읽는다). 16px와 고해상도 화면용 32px
for (const [name, size] of [['tray.png', 16], ['tray@2x.png', 32]]) {
  writeFileSync(join(import.meta.dirname, '..', 'resources', name), png(size, render(size)))
}
