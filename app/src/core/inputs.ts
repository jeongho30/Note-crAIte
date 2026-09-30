// 입력 파일: 녹음 옆의 같은 이름 필기(.md/.txt)를 찾고, 인코딩을 가려 읽는다.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'

/** 받는 녹음 확장자. 영상 컨테이너(mp4·webm·3gp)는 소리만 쓴다. 실제로 소리가 있는지는 ffmpeg로 다시 본다. */
export const AUDIO_EXTS = ['m4a', 'mp3', 'wav', 'ogg', 'flac', 'aac', 'mp4', '3gp', 'amr', 'webm', 'opus', 'wma']
export const NOTE_EXTS = ['md', 'txt']

const extOf = (path: string): string => extname(path).slice(1).toLowerCase()
const baseOf = (path: string): string => path.slice(0, path.length - extname(path).length)

export type Recording = { audio: string; notes: string | null }

/**
 * 끌어 놓거나 고른 파일을 녹음과 필기로 나눈다. 필기는 함께 넣은 같은 이름의 것을 먼저, 없으면 녹음 옆에서 찾는다.
 * 녹음도 필기도 아니거나, 짝이 되는 녹음 없이 넣은 필기는 ignored로 돌려준다.
 */
export function pairInputs(paths: string[]): { recordings: Recording[]; ignored: string[] } {
  const unique = [...new Set(paths.map((p) => resolve(p)))]
  const audios = unique.filter((p) => AUDIO_EXTS.includes(extOf(p)))
  const notes = new Map(unique.filter((p) => NOTE_EXTS.includes(extOf(p))).map((p) => [baseOf(p).toLowerCase(), p]))
  const used = new Set<string>()
  const recordings = audios.map((audio) => {
    const dropped = notes.get(baseOf(audio).toLowerCase())
    if (dropped) used.add(dropped)
    return { audio, notes: dropped ?? findNotes(audio) }
  })
  const ignored = unique.filter((p) => !audios.includes(p) && !used.has(p))
  return { recordings, ignored }
}

/**
 * 이미 목록에 있는 녹음에 붙일 필기를 골라낸다 (시작 전 확인에서 필기를 빼고 나중에 다시 넣을 때).
 * 같은 폴더·같은 이름의 녹음을 먼저 찾고, 없으면 파일 이름만 같은 녹음이 하나뿐일 때 붙인다.
 * 함께 고른 새 녹음과 이름이 같은 필기는 그 녹음의 것이라 rest에 남긴다.
 */
export function attachNotes(audios: string[], picked: string[]): { attached: { audio: string; notes: string }[]; rest: string[] } {
  const unique = [...new Set(picked.map((p) => resolve(p)))]
  const newBases = new Set(unique.filter((p) => AUDIO_EXTS.includes(extOf(p))).map((p) => baseOf(p).toLowerCase()))
  const byNote = new Map<string, string>() // 녹음 → 필기 (같은 녹음에 여럿이면 나중 것)
  const rest: string[] = []
  for (const p of unique) {
    const base = baseOf(p).toLowerCase()
    let audio: string | undefined
    if (NOTE_EXTS.includes(extOf(p)) && !newBases.has(base)) {
      audio = audios.find((a) => baseOf(a).toLowerCase() === base)
      if (!audio) {
        const name = basename(base)
        const same = audios.filter((a) => basename(baseOf(a)).toLowerCase() === name)
        if (same.length === 1) audio = same[0]
      }
    }
    if (audio) byNote.set(audio, p)
    else rest.push(p)
  }
  return { attached: [...byNote].map(([audio, notes]) => ({ audio, notes })), rest }
}

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
