<#
whisper.cpp를 배포용 옵션으로 빌드해 .cache/whisper/bin 에 모은다 (로컬과 CI가 같이 쓴다).

  -SourceDir  이미 받아 둔 whisper.cpp 체크아웃. 생략하면 고정 커밋을 .cache/whisper-src 에 받는다.
  -NoVulkan   Vulkan 없이 CPU 백엔드만 빌드한다.

옵션을 이렇게 둔 이유
  GGML_NATIVE=OFF, GGML_CPU_ALL_VARIANTS=ON  빌드한 PC의 명령어(AVX512 등)에 묶이지 않고 어느 CPU에서나 돈다.
  GGML_BACKEND_DL=ON                         ggml-vulkan.dll을 못 불러오는 PC에서도 CPU로 동작한다.
  MSVC 런타임 DLL을 exe 옆에 둔다             깨끗한 PC에는 VC++ 재배포 패키지가 없을 수 있다. 백엔드가 DLL 여러 개라
                                              DLL마다 CRT를 따로 갖게 되는 정적 링크(/MT)는 쓰지 않는다.
#>
param(
    [string]$SourceDir = "",
    [switch]$NoVulkan
)
$ErrorActionPreference = "Stop"
$Commit = "1da4dc82fa7996d4edda05890dca65aeceaafd6d"
$Root = (Resolve-Path "$PSScriptRoot\..").Path
$Cache = Join-Path $Root ".cache"
$BuildDir = Join-Path $Cache $(if ($NoVulkan) { "whisper-build-cpu" } else { "whisper-build" })
$OutDir = Join-Path $Cache "whisper\bin"

function Invoke-Checked([string]$What, [scriptblock]$Block) {
    # Windows PowerShell 5.1은 리디렉션된 네이티브 stderr(cmake 경고 등)를 오류로 바꿔 Stop에서 중단한다.
    # 네이티브 명령은 종료 코드로만 판단한다.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $Block } finally { $ErrorActionPreference = $prev }
    if ($LASTEXITCODE -ne 0) { throw "$What 실패 (exit $LASTEXITCODE)" }
}

if (-not $SourceDir) {
    $SourceDir = Join-Path $Cache "whisper-src"
    if (-not (Test-Path (Join-Path $SourceDir ".git"))) {
        New-Item -ItemType Directory -Force $SourceDir | Out-Null
        Invoke-Checked "git init" { git -C $SourceDir init -q }
        Invoke-Checked "git remote add" { git -C $SourceDir remote add origin https://github.com/ggml-org/whisper.cpp.git }
    }
    Invoke-Checked "git fetch" { git -C $SourceDir fetch -q --depth 1 origin $Commit }
    Invoke-Checked "git checkout" { git -C $SourceDir checkout -q --detach FETCH_HEAD }
}
$head = (git -C $SourceDir rev-parse HEAD).Trim()
if ($head -ne $Commit) { throw "whisper.cpp 커밋이 다릅니다: $head (필요: $Commit)" }

if (-not $NoVulkan) {
    if (-not $env:VULKAN_SDK) { $env:VULKAN_SDK = [Environment]::GetEnvironmentVariable("VULKAN_SDK", "Machine") }
    if (-not $env:VULKAN_SDK) { throw "Vulkan SDK가 없습니다. 설치하거나 -NoVulkan으로 CPU만 빌드하세요." }
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw "MSVC 빌드 도구가 없습니다 (Visual Studio Build Tools의 'C++를 사용한 데스크톱 개발' 필요)." }
Import-Module (Join-Path $vs "Common7\Tools\Microsoft.VisualStudio.DevShell.dll")
Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments "-arch=x64 -host_arch=x64" | Out-Null

$flags = @(
    "-G", "Ninja",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_C_COMPILER=cl", "-DCMAKE_CXX_COMPILER=cl",
    "-DGGML_NATIVE=OFF", "-DGGML_BACKEND_DL=ON", "-DGGML_CPU_ALL_VARIANTS=ON",
    "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_SERVER=OFF", "-DWHISPER_SDL2=OFF"
)
if (-not $NoVulkan) { $flags += "-DGGML_VULKAN=ON" }
Invoke-Checked "cmake 설정" { cmake -S $SourceDir -B $BuildDir @flags }
Invoke-Checked "빌드" { cmake --build $BuildDir --target whisper-cli -j }

if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force $OutDir | Out-Null
Get-ChildItem $BuildDir -Recurse -File -Include "whisper-cli.exe", "*.dll" |
    Where-Object { $_.FullName -notmatch "\\CMakeFiles\\" } |
    Copy-Item -Destination $OutDir -Force
Get-ChildItem (Join-Path $env:VCToolsRedistDir "x64") -Directory |
    Where-Object { $_.Name -match "^Microsoft\.VC\d+\.(CRT|OpenMP)$" } |
    ForEach-Object { Copy-Item (Join-Path $_.FullName "*.dll") $OutDir -Force }
Copy-Item (Join-Path $SourceDir "LICENSE") (Join-Path $OutDir "LICENSE-whisper.cpp.txt") -Force

Invoke-Checked "whisper-cli 실행 확인" { & (Join-Path $OutDir "whisper-cli.exe") --help *> $null }
Get-ChildItem $OutDir | Select-Object Name, @{ n = "MB"; e = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table -AutoSize
