# build-exe.ps1 — build aplikasi + installer .exe (single-file) untuk OflaBot
#
# Tahapan:
#   1. build renderer & main process (vite)
#   2. package app jadi folder portable (release\win-unpacked)
#   3. tempel ikon + metadata ke exe aplikasi (rcedit)
#   4. zip folder portable -> installer\payload.zip
#   5. compile installer .NET (installer\Setup.cs) dengan payload ter-embed
#      -> release\OflaBot-Setup-<versi>.exe (single file)
#
# Kenapa installer .NET, bukan NSIS?
# NSIS (electron-builder) gagal di build Windows mesin ini: NSIS tidak bisa
# membuat file temp sehingga muncul "Error writing temporary file". Installer
# .NET ini tidak membutuhkannya.
#
# Jalankan:  powershell -ExecutionPolicy Bypass -File .\build-exe.ps1

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$appName = 'OflaBot'
$ver = (Get-Content package.json -Raw | ConvertFrom-Json).version
$exePath = "release\win-unpacked\$appName.exe"
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

$env:ELECTRON_CACHE = Join-Path $PSScriptRoot '.electron-cache'
$env:ELECTRON_BUILDER_CACHE = Join-Path $PSScriptRoot '.eb-cache'

Write-Host '== 1/5 Build renderer + main process ==' -ForegroundColor Cyan
npx vite build
if ($LASTEXITCODE -ne 0) { throw 'vite build gagal' }

Write-Host '== 2/5 Package aplikasi (folder portable) ==' -ForegroundColor Cyan
# Folder lama harus dihapus: kalau aplikasi sedang berjalan, exe terkunci dan
# electron-builder gagal ("Unable to commit changes" / EBUSY).
$unpacked = Join-Path $PSScriptRoot 'release\win-unpacked'
if (Test-Path $unpacked) {
  try { Remove-Item -Recurse -Force $unpacked -ErrorAction Stop }
  catch { throw 'Tidak bisa menghapus release\win-unpacked. Tutup OflaBot dulu, lalu jalankan ulang build.' }
}
npx electron-builder --win --x64 --dir
if ($LASTEXITCODE -ne 0) { throw 'electron-builder --dir gagal' }
if (-not (Test-Path $exePath)) { throw "Build gagal: $exePath tidak ditemukan" }

Write-Host '== 3/5 Terapkan ikon + metadata exe aplikasi ==' -ForegroundColor Cyan
$rcedit = Join-Path $PSScriptRoot '.tools\winCodeSign\rcedit-x64.exe'
if (Test-Path $rcedit) {
  & $rcedit $exePath `
    --set-icon 'build\icon.ico' `
    --set-version-string 'ProductName' $appName `
    --set-version-string 'FileDescription' $appName `
    --set-version-string 'CompanyName' 'OflaBot' `
    --set-file-version $ver `
    --set-product-version $ver
} else {
  Write-Warning 'rcedit tidak ada; exe aplikasi memakai ikon default Electron.'
}

Write-Host '== 4/5 Buat payload installer ==' -ForegroundColor Cyan
New-Item -ItemType Directory -Force 'installer' | Out-Null
Remove-Item -Force 'installer\payload.zip' -ErrorAction SilentlyContinue
Compress-Archive -Path "release\win-unpacked\*" -DestinationPath 'installer\payload.zip' -CompressionLevel Optimal -Force

Write-Host '== 5/5 Compile installer .exe ==' -ForegroundColor Cyan
if (-not (Test-Path $csc)) { throw "csc.exe (.NET Framework 4) tidak ditemukan: $csc" }
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
  Where-Object { $_.Name -ne "OflaBot-Setup-$ver.exe" } |
  Remove-Item -Force -ErrorAction SilentlyContinue
Remove-Item -Force 'release\builder-debug.yml' -ErrorAction SilentlyContinue

Write-Host ''
Write-Host 'SELESAI. Hasil di folder release\:' -ForegroundColor Green
Get-ChildItem release -File | ForEach-Object {
  Write-Host ("  - {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB))
}
Write-Host "  - win-unpacked\  (versi portable tanpa installer)"
exit 0
