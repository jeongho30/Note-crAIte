from lnengine.files import write_json_atomic
from lnengine.stt.base import transcribe_chunks

CHUNKS = [
    {"file": "part_000.wav", "start_s": 0.0, "end_s": 600.0},
    {"file": "part_001.wav", "start_s": 600.0, "end_s": 1200.0},
]


class FakeEngine:
    def __init__(self):
        self.calls = []

    def transcribe(self, wav, *, language, on_progress=None, cancel=None):
        self.calls.append(wav.name)
        if on_progress:
            on_progress(0.5)
        return [{"start_ms": 1000, "end_ms": 2000, "text": wav.name}]


def test_merges_with_chunk_offsets_and_reports_progress(tmp_path):
    progress = []
    engine = FakeEngine()
    merged = transcribe_chunks(engine, CHUNKS, tmp_path / "chunks", tmp_path / "stt", language="ko",
                               on_progress=progress.append)
    assert merged == [
        {"start_ms": 1000, "end_ms": 2000, "text": "part_000.wav"},
        {"start_ms": 601000, "end_ms": 602000, "text": "part_001.wav"},
    ]
    assert progress == [0.25, 0.5, 0.75, 1.0]


def test_skips_finished_parts(tmp_path):
    (tmp_path / "stt").mkdir()
    write_json_atomic(tmp_path / "stt" / "part_000.json", [{"start_ms": 0, "end_ms": 10, "text": "이미 끝남"}])
    engine = FakeEngine()
    merged = transcribe_chunks(engine, CHUNKS, tmp_path / "chunks", tmp_path / "stt", language="ko")
    assert engine.calls == ["part_001.wav"]
    assert merged[0]["text"] == "이미 끝남"
    assert (tmp_path / "stt" / "part_001.json").exists()
