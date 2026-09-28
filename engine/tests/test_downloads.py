import hashlib
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from lnengine.downloads import download
from lnengine.errors import EngineError

PAYLOAD = bytes(range(256)) * 4096  # 1MB
SHA = hashlib.sha256(PAYLOAD).hexdigest()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        rng = self.headers.get("Range")
        self.server.ranges.append(rng)
        if rng and not self.server.ignore_range:
            start = int(rng.removeprefix("bytes=").split("-")[0])
            body = PAYLOAD[start:]
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{len(PAYLOAD) - 1}/{len(PAYLOAD)}")
        else:
            body = PAYLOAD
            self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture
def server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    srv.ranges = []
    srv.ignore_range = False
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    srv.url = f"http://127.0.0.1:{srv.server_port}/model.bin"
    yield srv
    srv.shutdown()


def test_full_download(server, tmp_path):
    dest = tmp_path / "model.bin"
    assert download(server.url, dest, len(PAYLOAD), SHA) == dest
    assert dest.read_bytes() == PAYLOAD
    assert not (tmp_path / "model.bin.part").exists()


def test_resumes_partial_file_with_range(server, tmp_path):
    (tmp_path / "model.bin.part").write_bytes(PAYLOAD[:1000])
    download(server.url, tmp_path / "model.bin", len(PAYLOAD), SHA)
    assert server.ranges == ["bytes=1000-"]
    assert (tmp_path / "model.bin").read_bytes() == PAYLOAD


def test_restarts_when_server_ignores_range(server, tmp_path):
    server.ignore_range = True
    (tmp_path / "model.bin.part").write_bytes(b"garbage" * 100)
    download(server.url, tmp_path / "model.bin", len(PAYLOAD), SHA)
    assert (tmp_path / "model.bin").read_bytes() == PAYLOAD


def test_hash_mismatch_removes_part(server, tmp_path):
    with pytest.raises(EngineError) as e:
        download(server.url, tmp_path / "model.bin", len(PAYLOAD), "0" * 64)
    assert e.value.code == "download"
    assert not (tmp_path / "model.bin.part").exists()
    assert not (tmp_path / "model.bin").exists()


def test_existing_complete_file_needs_no_network(tmp_path):
    dest = tmp_path / "model.bin"
    dest.write_bytes(PAYLOAD)
    assert download("http://127.0.0.1:9/unreachable", dest, len(PAYLOAD), SHA) == dest
