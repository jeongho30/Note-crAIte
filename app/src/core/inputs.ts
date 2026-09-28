// 입력 파일: 녹음 옆의 같은 이름 필기(.md/.txt)를 찾고, 인코딩을 가려 읽는다.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

const NOTE_EXTS = ['md', 'txt']

/** 녹음과 같은 폴더·같은 이름의 필기. 이름에 점이 흔하므로 실제 확장자만 떼어 낸다 ("9.14 Lexical.m4a" → "9.14 Lexical"). */
export function findNotes(audio: string): string | null {
  const base = audio.slice(0, audio.length - extname(audio).length)
  for (const ext of NOTE_EXTS) {
    if (existsSync(`${base}.${ext}`)) return `${base}.${ext}`
  }
  return null
}

/** UTF-8로 읽히지 않으면 CP949(EUC-KR)로 다시 읽는다 (오래된 메모장 파일). */
export async function readNotes(path: string): Promise<string> {
  const buf = await readFile(path)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder('euc-kr').decode(buf)
  }
}
