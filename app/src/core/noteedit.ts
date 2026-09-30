// 노트 속성(제목·과목·날짜) 수정: 머리말과 첫 제목 줄, 파일 이름과 폴더를 함께 바꾼다. 본문은 건드리지 않는다.
// 이 앱이 만든 노트(머리말에 title·date·source·stt가 있는 것)만 수정한다: 다른 앱의 노트는 머리말 모양을 알 수 없다.
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { EngineError } from './errors.ts'
import { safeName, tag } from './note.ts'

export type NoteProps = { title: string; subject: string | null; date: string }

const APP_KEYS = ['title', 'date', 'source', 'stt']
const samePath = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

/** 머리말 값: 이 앱은 JSON 문자열로 쓴다. 날짜는 따옴표 없이 쓰지만 따옴표가 있어도 읽는다. */
function valueOf(raw: string): string {
  const v = raw.trim()
  try {
    const j: unknown = JSON.parse(v)
    if (typeof j === 'string') return j
  } catch {
    // 따옴표 없는 값
  }
  return v.replace(/^["'](.*)["']$/, '$1')
}

function split(text: string): { eol: string; lines: string[]; end: number } | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  const end = lines.indexOf('---', 1)
  return end > 0 ? { eol, lines, end } : null
}

/** 이 앱이 만든 노트면 현재 속성, 아니면 null */
export function parseNoteProps(text: string): NoteProps | null {
  const parts = split(text)
  if (!parts) return null
  const fm = parts.lines.slice(1, parts.end)
  const get = (key: string): string | null => {
    const line = fm.find((l) => l.startsWith(key + ':'))
    return line === undefined ? null : valueOf(line.slice(key.length + 1))
  }
  if (APP_KEYS.some((k) => get(k) === null)) return null
  return { title: get('title')!, subject: get('subject') || null, date: get('date')! }
}

export function normalizeProps(p: NoteProps): NoteProps {
  const title = p.title.replace(/\s+/g, ' ').trim()
  const date = p.date.trim()
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date
  if (!title) throw new EngineError('input', '제목을 입력해 주세요.')
  if (!valid) throw new EngineError('input', '날짜는 2026-09-21처럼 써 주세요.')
  return { title, subject: p.subject?.trim() || null, date }
}

/** 수정한 속성으로 머리말·제목 줄을 바꾸고, 파일 이름·폴더도 맞춰 옮긴다. 새 경로와 저장한 속성을 돌려준다. */
export async function editNote(outDir: string, path: string, wanted: NoteProps): Promise<{ path: string; props: NoteProps }> {
  const next = normalizeProps(wanted)
  const text = await readFile(path, 'utf8').catch(() => {
    throw new EngineError('input', '노트 파일을 찾지 못했어요. 옮기거나 지웠을 수 있어요.')
  })
  const old = parseNoteProps(text)
  const parts = split(text)
  if (!old || !parts) throw new EngineError('input', '이 앱이 만든 노트만 수정할 수 있어요.')

  const { eol, lines, end } = parts
  const fm = lines.slice(1, end)
  const at = (key: string): number => fm.findIndex((l) => l.startsWith(key + ':'))
  fm[at('title')] = `title: ${JSON.stringify(next.title)}`
  fm[at('date')] = `date: ${next.date}`
  const s = at('subject')
  if (next.subject === null) {
    if (s >= 0) fm.splice(s, 1)
  } else if (s >= 0) {
    fm[s] = `subject: ${JSON.stringify(next.subject)}`
  } else {
    fm.splice(at('title') + 1, 0, `subject: ${JSON.stringify(next.subject)}`)
  }
  // 태그는 과목 태그만 바꾼다 (사용자가 옵시디언에서 더한 태그는 그대로)
  const t = at('tags')
  if (t >= 0) {
    try {
      const tags: unknown = JSON.parse(fm[t].slice('tags:'.length))
      if (Array.isArray(tags) && tags.every((x) => typeof x === 'string')) {
        const without = old.subject ? tags.filter((x) => x !== tag(old.subject!)) : tags
        fm[t] = `tags: ${JSON.stringify([...new Set([...without, ...(next.subject ? [tag(next.subject)] : [])])])}`
      }
    } catch {
      // 태그 줄을 읽지 못하면 그대로 둔다
    }
  }
  const body = lines.slice(end + 1)
  const h1 = body.findIndex((l) => /^# /.test(l))
  if (h1 >= 0) body[h1] = `# ${next.title}`
  const markdown = ['---', ...fm, '---', ...body].join(eol)

  // 과목이 바뀔 때만 폴더를, 제목이나 날짜가 바뀔 때만 파일 이름을 바꾼다 (그 밖의 것은 사용자가 정한 대로 둔다)
  const subjectChanged = (old.subject ?? null) !== next.subject
  const nameChanged = old.title !== next.title || old.date !== next.date
  const dir = subjectChanged ? join(outDir, safeName(next.subject || '미분류')) : dirname(path)
  let target = path
  if (subjectChanged || nameChanged) {
    const base = nameChanged ? `${next.date} ${safeName(next.title)}` : basename(path).replace(/\.md$/i, '')
    target = join(dir, `${base}.md`)
    for (let i = 2; existsSync(target) && !samePath(target, path); i++) target = join(dir, `${base} (${i}).md`)
  }

  await mkdir(dirname(target), { recursive: true })
  const tmp = target + '.tmp'
  await writeFile(tmp, markdown, 'utf8')
  await rename(tmp, target)
  if (!samePath(target, path)) {
    try {
      await unlink(path)
    } catch (e) {
      await unlink(target).catch(() => undefined) // 옛 파일을 못 지우면 새 파일도 되돌려 둘이 남지 않게
      throw new EngineError('input', '노트를 옮기지 못했어요: ' + (e instanceof Error ? e.message : String(e)))
    }
  }
  return { path: target, props: next }
}
