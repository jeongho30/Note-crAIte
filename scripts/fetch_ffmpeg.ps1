<#
설치본에 넣을 ffmpeg(LGPL 빌드)를 받아 .cache/ffmpeg/bin 에 둔다 (로컬과 CI가 같이 쓴다).

  BtbN/FFmpeg-Builds의 월말 자동 빌드는 오래 남아 있어 그중 하나를 고정한다. 받은 zip은 sha256으로 확인한다.
  GPL 빌드(개발 PC의 Gyan full_build 등)는 재배포하면 소스 제공 의무가 생겨 쓰지 않는다. 앱이 쓰는 기능
  (디코딩, 16kHz WAV 변환, silencedetect)은 LGPL 빌드에 다 있다.
  ffmpeg.exe와 라이선스만 꺼내고, 어떤 소스로 만든 빌드인지 FFMPEG-SOURCE.txt에 적는다(LGPL 고지).
#>
$ErrorActionPreference = "Stop"
$Tag = "autobuild-2026-08-31-13-27"
$Asset = "ffmpeg-n9.0.1-11-ge47273f4d9-win64-lgpl-9.0.zip"
$Sha256 = "2484854AD6988D34560F4E6EA7A6ECB9DDE0AF7C229D2591815D056B04EC4F56"
$Root = (Resolve-Path "$PSScriptRoot\..").Path
$Cache = Join-Path $Root ".cache"
$Zip = Join-Path $Cache $Asset
$OutDir = Join-Path $Cache "ffmpeg\bin"

New-Item -ItemType Directory -Force $Cache | Out-Null
if (-not (Test-Path $Zip) -or (Get-FileHash $Zip -Algorithm SHA256).Hash -ne $Sha256) {
    $url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$Tag/$Asset"
    Write-Host "받는 중: $url"
    $ProgressPreference = "SilentlyContinue" # 진행 표시가 있으면 Invoke-WebRequest가 아주 느리다
    Invoke-WebRequest $url -OutFile $Zip
}
$hash = (Get-FileHash $Zip -Algorithm SHA256).Hash
if ($hash -ne $Sha256) { throw "ffmpeg zip의 sha256이 다릅니다: $hash (필요: $Sha256)" }

$tmp = Join-Path $Cache "ffmpeg-unzip"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
Expand-Archive $Zip $tmp
$top = Get-ChildItem $tmp -Directory | Select-Object -First 1

if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force $OutDir | Out-Null
Copy-Item (Join-Path $top.FullName "bin\ffmpeg.exe") $OutDir
Copy-Item (Join-Path $top.FullName "LICENSE.txt") (Join-Path $OutDir "LICENSE-ffmpeg.txt")
Remove-Item -Recurse -Force $tmp

# Select-Object -First 1로 파이프를 끊으면 ffmpeg가 종료 코드 -1로 끝나 전부 받은 뒤 첫 줄을 쓴다
$out = & (Join-Path $OutDir "ffmpeg.exe") -hide_banner -version
$version = $out[0]
if ($LASTEXITCODE -ne 0) { throw "ffmpeg 실행 확인 실패 (exit $LASTEXITCODE)" }
if (($version -join "") -notmatch "ffmpeg version") { throw "ffmpeg 버전을 읽지 못했습니다: $version" }
@"
이 프로그램에 들어 있는 ffmpeg.exe는 FFmpeg(https://ffmpeg.org)를 LGPL v2.1 이상으로 빌드한 것이다.
$version

빌드: https://github.com/BtbN/FFmpeg-Builds/releases/tag/$Tag ($Asset)
빌드 스크립트: https://github.com/BtbN/FFmpeg-Builds
소스: 위 버전 문자열의 커밋(g 뒤 해시)을 https://git.ffmpeg.org/ffmpeg.git 에서 받을 수 있다.
라이선스 전문: LICENSE-ffmpeg.txt
"@ | Set-Content (Join-Path $OutDir "FFMPEG-SOURCE.txt") -Encoding UTF8
Write-Host $version
Get-ChildItem $OutDir | Select-Object Name, @{ n = "MB"; e = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table -AutoSize
