/** 처리 중 예상 가능한 실패. code로 화면이 한국어 사유와 재시도 여부를 고른다 (예: ffmpeg, stt_failed, download, network, cancelled). */
export class EngineError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'EngineError'
    this.code = code
  }
}
