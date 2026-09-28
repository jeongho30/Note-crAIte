// 전사끼리 비교: 띄어쓰기·문장부호를 뺀 글자 오류율(CER). S3 벤치와 하드웨어 감지가 같이 쓴다.

const NORMALIZE_RE = /[^0-9A-Za-z가-힣]/g

/** 띄어쓰기·문장부호 차이는 오류로 세지 않는다. */
export function normalize(text: string): string {
  return text.replace(NORMALIZE_RE, '').toLowerCase()
}

function levenshtein(a: string[], b: string[]): number {
  let prev = new Int32Array(b.length + 1).map((_, j) => j)
  let cur = new Int32Array(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    const ai = a[i - 1]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ai === b[j - 1] ? 0 : 1))
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[b.length]
}

export function cer(ref: string, hyp: string): number {
  const r = [...normalize(ref)]
  return levenshtein(r, [...normalize(hyp)]) / Math.max(1, r.length)
}
