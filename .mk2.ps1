$ErrorActionPreference = 'Stop'
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut('C:\Users\msyam\Desktop\OflaBot.lnk')
$s.TargetPath = 'C:\Windows\System32\wscript.exe'
$s.WorkingDirectory = 'D:\DeepSeek\aplikasi\release\OflaBot-Inst2'
$s.IconLocation = 'D:\DeepSeek\aplikasi\release\OflaBot-Inst2\OflaBot.exe,0'
$s.Arguments = '"D:\DeepSeek\aplikasi\release\OflaBot-Inst2\launch.vbs"'
$s.Save()
