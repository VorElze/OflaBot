$ErrorActionPreference = 'Stop'
$lnk = Join-Path $env:USERPROFILE 'Desktop\TestOfla2.lnk'
if (Test-Path $lnk) { Remove-Item -Force $lnk }
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = 'C:\Windows\System32\notepad.exe'
$s.WorkingDirectory = 'C:\Windows'
$s.Save()
Write-Output ("exists=" + (Test-Path $lnk))
