"""테스트용 가짜 whisper-cli: stdout으로 대량 출력, stderr로 진행률, -of 경로에 JSON을 쓴다."""

import json
import os
import sys
import time

args = sys.argv[1:]
mode = os.environ.get("FAKE_WHISPER_MODE", "ok")

if mode == "fail":
    print("error: failed to load model", file=sys.stderr)
    sys.exit(3)
if mode == "hang":
    time.sleep(60)

# 실제 whisper-cli처럼 전사 구간을 stdout으로 대량 출력한다 (어댑터가 파이프를 안 비우면 여기서 멈춘다).
sys.stdout.write(("[00:00:00.000 --> 00:00:01.000]  가나다라마바사아자차카타파하 " * 10 + "\n") * 2000)
sys.stdout.flush()
for p in range(0, 101, 5):
    print(f"whisper_print_progress_callback: progress = {p:3d}%", file=sys.stderr, flush=True)

out = args[args.index("-of") + 1] + ".json"
data = {"transcription": [
    {"offsets": {"from": 0, "to": 1500}, "text": " 안녕하세요"},
    {"offsets": {"from": 1500, "to": 1600}, "text": "  "},
    {"offsets": {"from": 2000, "to": 3000}, "text": " 강의를 시작합니다"},
]}
with open(out, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False)
