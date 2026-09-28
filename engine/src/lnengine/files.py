"""작업 폴더 파일을 원자적으로 쓰고 읽는다 (쓰다 만 파일이 재개 판정을 속이지 않게)."""

import json
import os
from pathlib import Path


def write_json_atomic(path: Path, data) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))
