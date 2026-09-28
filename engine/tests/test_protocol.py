import json
import subprocess
import sys

NOISY_SERVER = """
import os, sys
from lnengine import protocol
out = protocol.isolate_stdout()
def noisy(params):
    print("라이브러리 출력")
    os.write(1, b"native noise\\n")
    return {"ok": True}
protocol.Server(out, {"noisy": noisy}).serve(sys.stdin.buffer)
"""


def lines(stdout: bytes) -> list[dict]:
    return [json.loads(line) for line in stdout.decode("utf-8").splitlines() if line.strip()]


def test_serve_answers_ping_and_errors_then_exits_on_eof():
    requests = b'{"id": 1, "method": "ping"}\n{"id": 2, "method": "nope"}\nnot json\n'
    result = subprocess.run([sys.executable, "-m", "lnengine", "serve"], input=requests, capture_output=True,
                            timeout=30)
    assert result.returncode == 0
    ping, unknown, bad = lines(result.stdout)
    assert ping["id"] == 1 and ping["result"]["pong"] is True
    assert unknown["error"]["code"] == "unknown_method"
    assert bad["error"]["code"] == "bad_request"


def test_stdout_noise_goes_to_stderr_not_protocol():
    result = subprocess.run([sys.executable, "-c", NOISY_SERVER], input=b'{"id": 7, "method": "noisy"}\n',
                            capture_output=True, timeout=30)
    assert lines(result.stdout) == [{"id": 7, "result": {"ok": True}}]
    assert b"native noise" in result.stderr
