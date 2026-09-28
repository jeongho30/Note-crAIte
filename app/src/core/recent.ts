// 저장 폴더의 최근 노트: 저장 폴더 바로 아래와 과목 폴더(한 단계 아래)의 .md를 수정 시각 순으로.
// 옵시디언 볼트면 이 앱이 만들지 않은 노트도 섞인다(작성자 결정).
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export type RecentNote = { path: string; title: string; subject: string | null; date: string; modifiedMs: number }

const DATED = /^(\d{4}-\d{2}-\d{2}) (.+)$/

function localDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function mdFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md')).map((e) => e.name)
  } catch {
    return []
  }
}

export async function recentNotes(outDir: string, limit = 5): Promise<RecentNote[]> {
  let subjects: string[]
  try {
    subjects = (await readdir(outDir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  } catch {
    return []
  }
  const found: { path: string; name: string; subject: string | null }[] = []
  for (const name of await mdFiles(outDir)) found.push({ path: join(outDir, name), name, subject: null })
  for (const subject of subjects) {
    for (const name of await mdFiles(join(outDir, subject))) found.push({ path: join(outDir, subject, name), name, subject })
  }
  const notes = await Promise.all(
    found.map(async ({ path, name, subject }) => {
      const modifiedMs = (await stat(path)).mtimeMs
      const stem = name.slice(0, -3)
      // 이 앱의 노트 이름은 "날짜 제목". 그 밖의 노트는 수정한 날짜를 쓴다.
      const m = DATED.exec(stem)
      return { path, subject, modifiedMs, title: m ? m[2] : stem, date: m ? m[1] : localDate(modifiedMs) }
    })
  )
  return notes.sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, limit)
}
