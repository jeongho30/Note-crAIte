"""앱(Electron)과의 stdio 프로토콜: 한 줄에 JSON 하나 (UTF-8).

요청 {id, method, params} → 응답 {id, result} 또는 {id, error: {code, message}}. 이벤트는 {event, data}.
"""

import json
import os
import sys
import threading
import time
from typing import BinaryIO, Callable

import psutil

from lnengine.errors import EngineError

Handler = Callable[[dict], object]


def isolate_stdout() -> BinaryIO:
    """원래 stdout을 프로토콜 전용으로 떼어 두고, fd 1은 stderr로 돌린다.

    라이브러리나 네이티브 코드가 stdout에 무엇을 찍어도 프로토콜 줄이 깨지지 않게 한다.
    """
    sys.stdout.flush()
    proto_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return os.fdopen(proto_fd, "wb", buffering=0)


def exit_when_parent_dies(parent_pid: int, interval_s: float = 2.0) -> None:
    def watch():
        while psutil.pid_exists(parent_pid):
            time.sleep(interval_s)
        os._exit(0)

    threading.Thread(target=watch, daemon=True).start()


class Server:
    def __init__(self, out: BinaryIO, handlers: dict[str, Handler]):
        self._out = out
        self._lock = threading.Lock()
        self.handlers = handlers

    def send(self, msg: dict) -> None:
        line = json.dumps(msg, ensure_ascii=False).encode("utf-8") + b"\n"
        with self._lock:
            self._out.write(line)
            self._out.flush()

    def emit(self, event: str, data) -> None:
        self.send({"event": event, "data": data})

    def handle_line(self, line: bytes) -> None:
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            self.send({"id": None, "error": {"code": "bad_request", "message": "JSON 한 줄이 아닙니다."}})
            return
        rid = req.get("id")
        handler = self.handlers.get(req.get("method"))
        if handler is None:
            self.send({"id": rid, "error": {"code": "unknown_method", "message": f"모르는 메서드: {req.get('method')}"}})
            return
        try:
            self.send({"id": rid, "result": handler(req.get("params") or {})})
        except EngineError as e:
            self.send({"id": rid, "error": {"code": e.code, "message": e.message}})
        except Exception as e:  # 엔진이 죽지 않게 하고 앱에는 사유를 넘긴다
            self.send({"id": rid, "error": {"code": "internal", "message": f"{type(e).__name__}: {e}"}})

    def serve(self, stdin: BinaryIO) -> None:
        """stdin이 닫히면(앱 종료) 돌아온다."""
        for line in stdin:
            if line.strip():
                self.handle_line(line)
