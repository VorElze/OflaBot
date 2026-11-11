# build-exe.ps1 — build aplikasi + installer .exe (single-file) untuk OflaBot
#
# Tahapan:
#   1. build renderer & main process (vite)
#   2. package app jadi folder portable (release\win-unpacked)
#   3. rename exe Electron -> OflaBot-core.exe, compile LAUNCHER OflaBot.exe
#      (pengguna cukup double-click OflaBot.exe; launcher menambahkan --no-sandbox)
#   4. tempel ikon + metadata ke kedua exe (rcedit)
#   5. zip folder portable -> installer\payload.zip
#   6. compile installer .NET (installer\Setup.cs) dengan payload ter-embed
#      -> release\OflaBot-Setup-<versi>.exe (single file)
#
# Jalankan:  powershell -ExecutionPolicy Bypass -File .\build-exe.ps1

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$appName = 'OflaBot'
$ver = (Get-Content package.json -Raw | ConvertFrom-Json).version
$unpacked = Join-Path $PSScriptRoot 'release\win-unpacked'
$corePath = Join-Path $unpacked 'OflaBot-core.exe'
$launcherPath = Join-Path $unpacked 'OflaBot.exe'
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$rcedit = Join-Path $PSScriptRoot '.tools\winCodeSign\rcedit-x64.exe'

$env:ELECTRON_CACHE = Join-Path $PSScriptRoot '.electron-cache'
$env:ELECTRON_BUILDER_CACHE = Join-Path $PSScriptRoot '.eb-cache'

Write-Host '== 1/6 Build renderer + main process ==' -ForegroundColor Cyan
npx vite build
if ($LASTEXITCODE -ne 0) { throw 'vite build gagal' }

Write-Host '== 2/6 Package aplikasi (folder portable) ==' -ForegroundColor Cyan
# Folder lama harus dihapus: kalau aplikasi sedang berjalan, exe terkunci.
if (Test-Path $unpacked) {
  try { Remove-Item -Recurse -Force $unpacked -ErrorAction Stop }
  catch { throw 'Tidak bisa menghapus release\win-unpacked. Tutup OflaBot dulu, lalu jalankan ulang build.' }
}
npx electron-builder --win --x64 --dir
if ($LASTEXITCODE -ne 0) { throw 'electron-builder --dir gagal' }

$electronExe = Join-Path $unpacked "$appName.exe"
if (-not (Test-Path $electronExe)) { throw "Build gagal: $electronExe tidak ditemukan" }

Write-Host '== 3/6 Buat launcher OflaBot.exe (exe Electron jadi OflaBot-core.exe) ==' -ForegroundColor Cyan
Move-Item -Force $electronExe $corePath
if (-not (Test-Path $csc)) { throw "csc.exe (.NET Framework 4) tidak ditemukan: $csc" }
& $csc /nologo /target:winexe /platform:x64 /optimize+ `
  "/out:$launcherPath" `
  /win32icon:"build\icon.ico" `
  /r:System.Windows.Forms.dll `
  "installer\OflaBotLauncher.cs"
if ($LASTEXITCODE -ne 0) { throw 'compile launcher gagal' }

Write-Host '== 4/6 Terapkan ikon + metadata exe ==' -ForegroundColor Cyan
if (Test-Path $rcedit) {
  foreach ($exe in @($corePath, $launcherPath)) {
    & $rcedit $exe `
      --set-icon 'build\icon.ico' `
      --set-version-string 'ProductName' $appName `
      --set-version-string 'FileDescription' $appName `
      --set-version-string 'CompanyName' 'OflaBot' `
      --set-file-version $ver `
      --set-product-version $ver
  }
} else {
  Write-Warning 'rcedit tidak ada; exe memakai ikon default.'
}

Write-Host '== 5/6 Buat payload installer ==' -ForegroundColor Cyan
# buang sisa data uji supaya payload bersih
foreach ($junk in @('userdata','install-log.txt','grokbot-crash.log','oflabot-crash.log')) { Remove-Item -Recurse -Force (Join-Path $unpacked $junk) -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force 'installer' | Out-Null
Remove-Item -Force 'installer\payload.zip' -ErrorAction SilentlyContinue
Compress-Archive -Path "release\win-unpacked\*" -DestinationPath 'installer\payload.zip' -CompressionLevel Optimal -Force

Write-Host '== 6/6 Compile installer .exe ==' -ForegroundColor Cyan
& $csc /nologo /target:winexe /platform:x64 /optimize+ `
  "/out:installer\Setup.exe" `
  /win32icon:"build\icon.ico" `
  "/resource:installer\payload.zip,payload.zip" `
  /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll `
  "installer\Setup.cs"
if ($LASTEXITCODE -ne 0) { throw 'compile installer gagal' }

Copy-Item 'installer\Setup.exe' "release\OflaBot-Setup-$ver.exe" -Force

# Bersihkan artefak lama dengan penamaan berbeda.
Get-ChildItem 'release' -Filter '*Setup*' -File |
  Where-Object { $_.Name -notlike "OflaBot-Setup-$ver*" } |
  Remove-Item -Force -ErrorAction SilentlyContinue
Remove-Item -Force 'release\builder-debug.yml' -ErrorAction SilentlyContinue

Write-Host ''
Write-Host 'SELESAI. Hasil di folder release\:' -ForegroundColor Green
Get-ChildItem release -File | ForEach-Object {
  Write-Host ("  - {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB))
}
Write-Host "  - win-unpacked\  (versi portable: OflaBot.exe = launcher, OflaBot-core.exe = Electron)"
exit 0
