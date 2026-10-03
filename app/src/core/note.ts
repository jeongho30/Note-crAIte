// 노트 마크다운을 만들고 저장 폴더에 쓴다. 기존 파이프라인 generate_note()의 템플릿을 artifact의 노트 구성으로 바꾼 것이다.
// 접는 부분은 <details> 대신 옵시디언 callout(> [!quote]-)으로 쓴다: 옵시디언은 <details> 안의 마크다운을 처리하지 않는다.
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Paragraph } from './clean.ts'
import type { AppliedCorrection } from './corrections.ts'

export type NoteInput = {
  title: string
  subject: string | null
  date: string // YYYY-MM-DD
  source: string // 녹음 파일 이름
  stt: string
  llm: string | null // 요약 모델. null이면 요약 없이 전사만 담은 노트
  summary: string | null
  keywords: string[]
  transcript: string[] // 교정 목록을 적용한 문단, 또는 다듬은 문단
  /** 전사문을 다듬은 모델. null이면 교정 목록만 적용했다 */
  polishedBy?: string | null
  original: Paragraph[] // 코드로 정리만 한 문단 (시각 포함)
  applied: AppliedCorrection[]
}

export function timestamp(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const mmss = `${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return h ? `${h}:${mmss}` : mmss
}

/**
 * 태그처럼 보이는 `<`를 글자로 남긴다 (`#include <iostream>` → `#include \<iostream>`).
 * 옵시디언은 닫히지 않은 태그 뒤를 전부 HTML로 읽어, 그 줄 뒤의 callout이 접히지 않고 본문으로 쏟아진다 (10/4).
 * 낱말 앞의 `#`도 글자로 남긴다 (`#include` → `\#include`): 옵시디언이 본문의 `#낱말`을 태그로 만든다.
 * 코드(`…`)와 수식($…$) 안은 그대로 둔다.
 */
export function escapeTags(text: string): string {
  return text.split(/(`[^`\n]*`|\$[^$\n]*\$)/).map((part, i) => (i % 2 ? part
    : part.replace(/(?<!\\)<(?=[A-Za-z/!?])/g, '\\<').replace(/(?<![\p{L}\p{N}\\&])#(?=[\p{N}_/-]*\p{L})/gu, '\\#'))).join('')
}

function callout(title: string, lines: string[]): string {
  return [`> [!quote]- ${title}`, ...lines.map((l) => (l ? `> ${escapeTags(l)}` : '>'))].join('\n')
}

/** 옵시디언 태그에는 공백·문장부호를 쓸 수 없다. */
export function tag(text: string): string {
  return text.trim().replace(/[^\p{L}\p{N}_\-/]+/gu, '_')
}

export function renderNote(n: NoteInput): string {
  const title = n.title.replace(/\s+/g, ' ').trim()
  const tags = ['lecture', ...(n.subject ? [tag(n.subject)] : [])]
  // frontmatter 값은 JSON 문자열로 쓴다. JSON 문자열은 YAML의 큰따옴표 문자열로도 올바르다.
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title)}`,
    ...(n.subject ? [`subject: ${JSON.stringify(n.subject)}`] : []),
    `date: ${n.date}`,
    `source: ${JSON.stringify(n.source)}`,
    `stt: ${JSON.stringify(n.stt)}`,
    ...(n.llm ? [`llm: ${JSON.stringify(n.llm)}`] : []),
    ...(n.polishedBy ? [`polish: ${JSON.stringify(n.polishedBy)}`] : []),
    `tags: ${JSON.stringify(tags)}`,
    '---'
  ].join('\n')

  const parts = [frontmatter, `# ${title}`]
  if (n.summary !== null) {
    parts.push(`## 요약\n\n${escapeTags(n.summary)}`)
    parts.push(`## 주요 키워드\n\n${n.keywords.length ? n.keywords.map((k) => `- ${escapeTags(k)}`).join('\n') : '(없음)'}`)
  }
  // 전사문도 원문 정리본·교정 내역처럼 접어 둔다 (길어서 요약을 읽는 데 방해되지 않게)
  // 다듬은 전사문은 모델이 말하지 않은 내용을 넣거나 뺄 수 있어, 원문 정리본과 대조하라고 제목에 적는다
  const transcriptTitle = n.polishedBy ? `전사문 (${n.polishedBy}가 다듬음 · 원문은 아래 원문 정리본)` : '전사문'
  parts.push(callout(transcriptTitle, n.transcript.flatMap((p, i) => [...(i ? [''] : []), p])))
  parts.push(callout('원문 정리본 (타임스탬프)',
                     n.original.flatMap((p, i) => [...(i ? [''] : []), `**[${timestamp(p.startMs)}]** ${p.text}`])))
  if (n.applied.length) {
    parts.push(callout(`교정 내역 (${n.applied.length}건)`, n.applied.map((c) => `- ${c.wrong} → ${c.right} (${c.count}회)`)))
  }
  return parts.join('\n\n') + '\n'
}

const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Windows 파일 이름으로 쓸 수 있게 금지 문자·끝의 점과 공백·예약된 이름을 처리한다. */
export function safeName(name: string, max = 80): string {
  let s = Array.from(name.replace(FORBIDDEN, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('')
  s = s.replace(/[. ]+$/, '')
  if (!s || RESERVED.test(s)) s = `_${s}`
  return s
}

/**
 * <outDir>/<과목|미분류>/<날짜> <제목>.md에 쓴다. 이름이 겹치면 " (2)"를 붙인다.
 * existing(이전에 저장한 경로)이 있으면 그 파일이 있던 폴더에 쓴다 (요약만 다시 만들기): 날짜와 제목이 그대로면 그 파일에 덮어쓰고,
 * 제목이 바뀌었으면 새 이름으로 쓴 뒤 옛 파일을 지운다 (파일 이름과 안의 제목이 어긋나지 않게).
 * 임시 파일에 쓴 뒤 바꿔 끼워 옵시디언 동기화가 쓰다 만 파일을 가져가지 않게 한다.
 */
export async function saveNote(outDir: string, subject: string | null, date: string, title: string,
                               markdown: string, existing?: string): Promise<string> {
  const base = `${date} ${safeName(title)}`
  const dir = existing ? dirname(existing) : join(outDir, safeName(subject || '미분류'))
  // 이름이 겹쳐 붙인 " (2)"는 같은 이름으로 본다
  const sameName = existing !== undefined && basename(existing).replace(/( \(\d+\))?\.md$/i, '') === base
  let path = sameName ? existing : join(dir, `${base}.md`)
  if (!sameName) {
    await mkdir(dir, { recursive: true })
    for (let i = 2; existsSync(path); i++) path = join(dir, `${base} (${i}).md`)
  }
  const tmp = path + '.tmp'
  await writeFile(tmp, markdown, 'utf8')
  await rename(tmp, path)
  if (existing && !sameName) await rm(existing, { force: true })
  return path
}
