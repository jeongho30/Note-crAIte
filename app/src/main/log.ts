// 앱 기록: <데이터 폴더>/logs/YYYY-MM-DD.log 에 한 줄씩 덧붙인다. 설정 > 정보의 [로그 폴더 열기]로 본다.
// 문제를 알려 줄 때 보내 달라고 할 수 있게, API 키·전사문·요약 내용은 적지 않는다(작업 이름·단계·오류만).
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const KEEP_DAYS = 14

const pad = (n: number): string => String(n).padStart(2, '0')

export function createLog(dir: string) {
  function file(d: Date): string {
    return join(dir, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`)
  }

  function write(message: string): void {
    const d = new Date()
    const line = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${message.replace(/\r?\n/g, ' ⏎ ')}\n`
    try {
      mkdirSync(dir, { recursive: true })
      appendFileSync(file(d), line, 'utf8')
    } catch {
      // 기록을 못 남겨도 앱은 계속한다
    }
  }

  /** 오래된 기록 파일을 지운다 (최근 KEEP_DAYS개만 남김). */
  function prune(): void {
    try {
      const logs = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort()
      for (const f of logs.slice(0, -KEEP_DAYS)) rmSync(join(dir, f), { force: true })
    } catch {
      // 폴더가 아직 없음
    }
  }

  return { write, prune, dir }
}
