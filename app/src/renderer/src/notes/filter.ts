import type { RecentNote } from '../../../core/recent'

export type Sort = 'modified' | 'date'
/** 과목 거르기: 전체, 미분류(과목 폴더 밖), 과목 이름 */
export type SubjectFilter = { kind: 'all' } | { kind: 'none' } | { kind: 'subject'; name: string }

/** 제목·과목에 검색어가 모두 들어 있는 노트만(대소문자 무시, 띄어 쓴 낱말마다), 정렬해서 돌려준다. */
export function filterNotes(notes: RecentNote[], query: string, subject: SubjectFilter, sort: Sort): RecentNote[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = notes.filter((n) => {
    if (subject.kind === 'none' && n.subject !== null) return false
    if (subject.kind === 'subject' && n.subject !== subject.name) return false
    const text = `${n.title} ${n.subject ?? ''}`.toLowerCase()
    return words.every((w) => text.includes(w))
  })
  // 강의 날짜 순은 같은 날이면 최근 수정 순
  return shown.sort((a, b) => (sort === 'date' ? b.date.localeCompare(a.date) : 0) || b.modifiedMs - a.modifiedMs)
}
