// 노트 미리보기용 마크다운 해석. 옵시디언과 같은 모양이 되게 두 가지를 따로 다룬다:
// frontmatter(---로 둘러싼 머리말)는 본문에서 빼서 메타데이터로 쓰고,
// callout(> [!quote]- 제목)은 접는 영역으로, "## 주요 키워드" 아래 목록은 칩으로 그린다.

import MarkdownIt from 'markdown-it'
import cjkFriendly from 'markdown-it-cjk-friendly'
import katexModule from '@vscode/markdown-it-katex'

// HTML은 그대로 글자로 보인다(노트에 섞인 태그가 화면에서 실행되지 않게). 링크는 미리보기의 onClick에서 브라우저로 넘긴다.
// cjk-friendly: 표준 규칙은 "**파싱(Parsing)**을"처럼 닫는 ** 앞이 문장부호이고 뒤에 조사가 붙으면 굵게 하지 않는다. 한국어에서도 굵게 되게 넓힌다.
// katex: 한 줄 수식과 블록 수식을 LaTeX로 그린다(달러 기호 한 쌍과 두 쌍). 문법 오류는 던지지 않고 빨간 글자로 보인다. "$5와 $10"처럼 $ 안쪽이 공백이거나 닫는 $ 뒤에 숫자가 오면 수식으로 보지 않는다.
// CommonJS 패키지라 Node(테스트)에서는 default가 모듈 객체로 들어온다
const katex = (katexModule as unknown as { default?: typeof katexModule }).default ?? katexModule
export const md = new MarkdownIt({ html: false, linkify: false, typographer: false }).use(cjkFriendly).use(katex, { throwOnError: false })

export type Frontmatter = Record<string, unknown>

export type Segment =
  | { kind: 'markdown'; text: string }
  | { kind: 'callout'; title: string; open: boolean; text: string }
  | { kind: 'keywords'; items: string[] }

export type ParsedNote = { meta: Frontmatter; title: string | null; segments: Segment[] }

const CALLOUT = /^>\s*\[!([\w-]+)\]([+-]?)\s*(.*)$/
const KEYWORDS = /^##\s+주요 키워드\s*$/
const LIST_ITEM = /^\s*[-*+]\s+(.+)$/

/** 이 앱은 값을 JSON 문자열로 쓴다. 다른 앱이 쓴 YAML 값은 글자 그대로 둔다. */
function parseFrontmatter(lines: string[]): Frontmatter {
  const meta: Frontmatter = {}
  for (const line of lines) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line)
    if (!m) continue
    try {
      meta[m[1]] = JSON.parse(m[2])
    } catch {
      meta[m[1]] = m[2].replace(/^["'](.*)["']$/, '$1')
    }
  }
  return meta
}

export function parseNote(markdown: string): ParsedNote {
  let lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  let meta: Frontmatter = {}
  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1)
    if (end > 0) {
      meta = parseFrontmatter(lines.slice(1, end))
      lines = lines.slice(end + 1)
    }
  }

  // 첫 # 제목은 미리보기 머리에 따로 보인다
  let title: string | null = null
  const h1 = lines.findIndex((l) => /^#\s+/.test(l))
  if (h1 >= 0 && lines.slice(0, h1).every((l) => !l.trim())) {
    title = lines[h1].replace(/^#\s+/, '').trim()
    lines = lines.slice(h1 + 1)
  }

  const segments: Segment[] = []
  let buf: string[] = []
  const flush = (): void => {
    if (buf.some((l) => l.trim())) segments.push({ kind: 'markdown', text: buf.join('\n') })
    buf = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const callout = CALLOUT.exec(line)
    if (callout) {
      flush()
      const body: string[] = []
      while (i + 1 < lines.length && lines[i + 1].startsWith('>')) body.push(lines[++i].replace(/^>\s?/, ''))
      segments.push({ kind: 'callout', title: callout[3] || callout[1], open: callout[2] !== '-', text: body.join('\n') })
      continue
    }
    if (KEYWORDS.test(line)) {
      // 제목 아래 빈 줄을 건너 목록만 칩으로. 목록이 아니면(예: "(없음)") 그대로 둔다
      let j = i + 1
      while (j < lines.length && !lines[j].trim()) j++
      const items: string[] = []
      while (j < lines.length && LIST_ITEM.test(lines[j])) items.push(LIST_ITEM.exec(lines[j++])![1].trim())
      if (items.length) {
        buf.push(line)
        flush()
        segments.push({ kind: 'keywords', items })
        i = j - 1
        continue
      }
    }
    buf.push(line)
  }
  flush()
  return { meta, title, segments }
}
