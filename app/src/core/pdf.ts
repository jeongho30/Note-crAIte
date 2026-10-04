// PDF 필기: 글자 층에서 쪽마다 글자를 뽑는다. 스캔본처럼 글자 층이 없거나 글꼴 정보가 없어 글자가 깨지는 PDF는 쓰지 않는다.
import { readFile } from 'node:fs/promises'
import { extractText, getDocumentProxy } from 'unpdf'
import { EngineError } from './errors.ts'

/** 전체에서 이만큼도 글자가 없으면 글자 층이 없는 PDF(스캔본·그림)로 본다 */
const MIN_CHARS = 20
/** 뽑은 글자 중 깨진 글자(대체 문자·사용자 정의 영역·제어 문자)가 이 비율을 넘으면 읽지 못한 것으로 본다 */
const MAX_BROKEN = 0.3

/** 쪽마다 뽑은 글자. 열지 못하면(손상, 암호) EngineError('input') */
export async function pdfPages(path: string): Promise<string[]> {
  const data = new Uint8Array(await readFile(path))
  try {
    const pdf = await getDocumentProxy(data, { verbosity: 0 })
    try {
      return (await extractText(pdf, { mergePages: false })).text
    } finally {
      await pdf.loadingTask.destroy()
    }
  } catch (e) {
    const name = (e as Error)?.name
    if (name === 'PasswordException') throw new EngineError('input', '암호가 걸린 PDF라 필기로 쓸 수 없어요')
    throw new EngineError('input', 'PDF를 열지 못했어요 (파일이 손상됐을 수 있어요)')
  }
}

/** 필기노트로 넘길 글: 쪽 번호를 달고 빈 쪽은 뺀다 (요약이 "3쪽 슬라이드"처럼 짚을 수 있게) */
export function pagesToNotes(pages: string[]): string {
  return pages
    .map((t, i) => [i + 1, t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()] as const)
    .filter(([, t]) => t)
    .map(([n, t]) => `[${n}쪽]\n${t}`)
    .join('\n\n')
}

/** 필기로 쓸 수 없는 이유. 쓸 수 있으면 null */
export function pagesProblem(pages: string[]): string | null {
  const chars = pages.join('').replace(/\s+/g, '')
  if (chars.length < MIN_CHARS) return '글자가 없는 PDF(스캔본이나 그림)라 필기로 쓸 수 없어요'
  const broken = chars.match(/[\uFFFD\uE000-\uF8FF\u0000-\u001F]/g)?.length ?? 0
  if (broken / chars.length > MAX_BROKEN) return '글자가 깨져 나오는 PDF라 필기로 쓸 수 없어요'
  return null
}

/** PDF 필기를 읽어 노트용 글로. 쓸 수 없으면 EngineError('input') */
export async function readPdfNotes(path: string): Promise<string> {
  const pages = await pdfPages(path)
  const problem = pagesProblem(pages)
  if (problem) throw new EngineError('input', problem)
  return pagesToNotes(pages)
}

/** 시작 전 확인·자동 처리에서 PDF 필기를 미리 열어 본다. 쓸 수 있으면 null, 아니면 이유 */
export async function pdfNotesProblem(path: string): Promise<string | null> {
  try {
    return pagesProblem(await pdfPages(path))
  } catch (e) {
    return e instanceof EngineError ? e.message : 'PDF를 열지 못했어요'
  }
}
