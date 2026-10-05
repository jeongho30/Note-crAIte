// 노트 미리보기의 찾기(Ctrl+F): 본문의 글에서 찾는 말의 위치를 구한다.
// 칠하기는 CSS Custom Highlight로 해서 본문의 DOM을 건드리지 않는다.

/** text에서 query가 나오는 시작 위치들 (대소문자를 가리지 않고, 겹치지 않게) */
export function findMatches(text: string, query: string): number[] {
  if (!query) return []
  let hay = text.toLowerCase()
  let needle = query.toLowerCase()
  // 소문자로 바꾸면 길이가 달라지는 글자(İ 등)가 있으면 위치가 어긋나므로 그대로 찾는다
  if (hay.length !== text.length || needle.length !== query.length) {
    hay = text
    needle = query
  }
  const found: number[] = []
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) found.push(at)
  return found
}

/** root 안에서 query가 나오는 곳들. 굵게·수식처럼 여러 요소에 걸친 말도 찾는다 */
export function findRanges(root: HTMLElement, query: string): Range[] {
  // KaTeX는 같은 수식을 화면용과 숨긴 MathML로 두 번 넣는다: 숨긴 쪽은 뺀다
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('.katex-mathml') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  })
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text)
    starts.push(text.length)
    text += (n as Text).data
  }
  const end = (i: number): number => starts[i] + nodes[i].data.length
  let i = 0
  return findMatches(text, query).map((at) => {
    while (end(i) <= at) i++
    let j = i
    while (end(j) < at + query.length) j++
    const range = document.createRange()
    range.setStart(nodes[i], at - starts[i])
    range.setEnd(nodes[j], at + query.length - starts[j])
    return range
  })
}
