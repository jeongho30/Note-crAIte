<#
노트북에서 S3(로컬 STT 비교)를 돌린다. 전원을 연결한 상태에서 실행한다.

  -WhisperBin  데스크톱의 .cache\whisper\bin 을 복사해 둔 폴더 (노트북에는 빌드 도구가 없을 수 있어서)
  -Audio       강의 녹음 (예: 9.22 game.m4a)
  -Ref         그 녹음의 기준 전사 (데스크톱 pipeline의 work\<이름>.json)
  -Full        10분 샘플(600초부터) 대신 녹음 전체로 잰다. -Configs로 후보만 골라서 쓴다.
  -Threads     0이면 물리 코어 - 2

gpu0 설정은 GPU가 없으면 CPU로 돈다. 결과표의 backend 열로 실제로 무엇을 썼는지 확인한다.
결과는 %LOCALAPPDATA%\lecture-notes\bench\<시각>\results.csv 에 남는다.
#>
param(
    [Parameter(Mandatory)] [string]$WhisperBin,
    [Parameter(Mandatory)] [string]$Audio,
    [Parameter(Mandatory)] [string]$Ref,
    [switch]$Full,
    [string[]]$Configs = @(
        "wcpp:small-q5_1:cpu", "fw:small:cpu",
        "wcpp:medium-q5_0:cpu", "wcpp:large-v3-turbo-q5_0:cpu", "fw:large-v3-turbo:cpu",
        "wcpp:small-q5_1:gpu0", "wcpp:large-v3-turbo-q5_0:gpu0"
    ),
    [int]$Threads = 0
)
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path "$PSScriptRoot\..").Path
$Venv = Join-Path $Root "engine\.venv"
$Py = Join-Path $Venv "Scripts\python.exe"

function Invoke-Checked([string]$What, [scriptblock]$Block) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $Block } finally { $ErrorActionPreference = $prev }
    if ($LASTEXITCODE -ne 0) { throw "$What 실패 (exit $LASTEXITCODE)" }
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    throw "ffmpeg가 PATH에 없습니다. 'winget install Gyan.FFmpeg'로 설치한 뒤 새 터미널에서 다시 실행하세요."
}

$bin = Join-Path $Root ".cache\whisper\bin"
New-Item -ItemType Directory -Force $bin | Out-Null
Copy-Item (Join-Path $WhisperBin "*") $bin -Force

if (-not (Test-Path $Py)) {
    # Microsoft Store판 Python은 %LOCALAPPDATA% 쓰기가 가상화돼 모델·결과가 엉뚱한 곳에 저장된다.
    $base = (py -3.14 -c "import sys; print(sys.base_prefix)")
    if ($base -match "WindowsApps") { throw "Microsoft Store판 Python입니다. python.org에서 3.14를 설치하세요." }
    Invoke-Checked "venv 생성" { py -3.14 -m venv $Venv }
    Invoke-Checked "엔진 설치" { & $Py -m pip install -q -e "$Root\engine[bench]" }
}

$env:PYTHONUTF8 = "1"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
Invoke-Checked "모델 받기" { & $Py -m lnengine models download silero-v6.2.0 small-q5_1 medium-q5_0 large-v3-turbo-q5_0 }

$benchArgs = @("-m", "lnengine", "bench", "--audio", $Audio, "--ref", $Ref)
if (-not $Full) { $benchArgs += @("--start", "600", "--duration", "600") }
if ($Threads -gt 0) { $benchArgs += @("--threads", "$Threads") }
foreach ($c in $Configs) { $benchArgs += @("--config", $c) }
Invoke-Checked "벤치" { & $Py @benchArgs }
