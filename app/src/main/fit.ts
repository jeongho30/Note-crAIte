// 창 크기 계산 (electron 없이 시험할 수 있게 따로 둔다).
export type Size = { width: number; height: number }

/**
 * 화면 영역(창 틀 제외)을 ratio로 두고, 창 틀까지 작업 영역에 들어가는 가장 큰 크기.
 * target보다 크게 만들지 않고, min보다 작게 만들지 않는다(작업 영역이 min보다 작으면 넘칠 수 있다).
 */
export function fitContent(target: Size, workArea: Size, frame: Size, ratio: number, min: Size): Size {
  const width = Math.min(target.width, workArea.width - frame.width, Math.floor((workArea.height - frame.height) * ratio))
  if (width < min.width) return min
  return { width, height: Math.round(width / ratio) }
}
