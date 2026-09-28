# PyInstaller 설정: onedir + console.
#   onedir: onefile은 실행할 때마다 임시 폴더에 풀어서 느리고 백신 오탐이 잦다.
#   console: windowed로 묶으면 stdio가 없을 수 있다. 창은 Electron이 windowsHide로 숨긴다.
# 빌드: engine/.venv/Scripts/pyinstaller engine/engine.spec --distpath dist --workpath .cache/pyinstaller
from PyInstaller.utils.hooks import collect_data_files

a = Analysis(
    ["src/lnengine/__main__.py"],
    pathex=["src"],
    datas=collect_data_files("lnengine"),  # data/*.json, prompts/*.txt
    # 벤치 전용 의존성은 앱에 넣지 않는다 (bench는 cli에서 필요할 때만 import)
    excludes=["faster_whisper", "ctranslate2", "onnxruntime", "av", "rapidfuzz", "pytest"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="engine", console=True, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name="engine", upx=False)
