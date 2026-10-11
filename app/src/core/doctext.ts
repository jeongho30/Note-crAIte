// 문서 필기(.hwpx·.docx·.pptx)에서 글자만 뽑는다. 셋 다 ZIP 안의 XML이고, 수식·그림은 버린다.
import { strFromU8, unzipSync } from 'fflate'

export const DOC_EXTS = ['hwpx', 'docx', 'pptx']

// 형식마다 본문이 든 파일과 문단·글자 태그의 이름 공간 (<w:p>·<w:t>, <hp:p>·<hp:t>, <a:p>·<a:t>)
const FORMATS: Record<string, { files: RegExp; ns: string }> = {
  docx: { files: /^word\/document\.xml$/, ns: 'w' },
  hwpx: { files: /^Contents\/section\d+\.xml$/, ns: 'hp' },
  pptx: { files: /^ppt\/slides\/slide\d+\.xml$/, ns: 'a' }
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }

function unescapeXml(s: string): string {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(\w+));/gi, (all, hex, dec, name) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : ENTITIES[name] ?? all)
}

/** 문단마다 한 줄로 글자를 모은다. 표 안의 문단과 줄 바꿈·탭도 줄을 나눈다. */
function lines(xml: string, ns: string): string[] {
  const token = new RegExp(`<${ns}:t(?:\\s[^>]*)?(?<!/)>([\\s\\S]*?)</${ns}:t>|</?${ns}:p(?:\\s[^>]*)?>|<${ns}:(?:br|tab)(?:\\s[^>]*)?/>`, 'g')
  const out: string[] = []
  let line = ''
  const flush = (): void => {
    if (line.trim()) out.push(line.trim())
    line = ''
  }
  for (const m of xml.matchAll(token)) {
    // hwpx는 글자 사이에 탭·줄 바꿈 태그가 끼어 있다
    if (m[1] !== undefined) line += unescapeXml(m[1].replace(/<[^>]+>/g, ' '))
    else flush()
  }
  flush()
  return out
}

/** 문서 파일의 글자. 구역·슬라이드는 번호 순서대로 빈 줄로 나눈다. 읽을 수 없는 파일(암호, 깨짐)이면 던진다. */
export function documentText(data: Uint8Array, ext: string): string {
  const { files, ns } = FORMATS[ext]
  const entries = Object.entries(unzipSync(data, { filter: (f) => files.test(f.name) }))
  if (!entries.length) throw new Error('본문이 없는 문서')
  const order = (name: string): number => Number(/\d+/.exec(name)?.[0] ?? 0)
  return entries
    .sort(([a], [b]) => order(a) - order(b))
    .map(([, xml]) => lines(strFromU8(xml), ns).join('\n'))
    .filter(Boolean)
    .join('\n\n')
}
