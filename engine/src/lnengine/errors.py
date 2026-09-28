"""엔진의 예상 가능한 실패."""


class EngineError(Exception):
    """code로 앱이 한국어 사유와 재시도 여부를 고른다 (예: ffmpeg, stt_failed, download, network, cancelled)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message
