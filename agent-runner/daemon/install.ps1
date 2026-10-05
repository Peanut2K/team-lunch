# Register agent-runner to start hidden at every Windows logon (Startup folder, no admin needed),
# then start it now.
$run = Join-Path $PSScriptRoot "run.ps1"
$startup = [Environment]::GetFolderPath("Startup")
$vbs = Join-Path $startup "team-lunch-agent-runner.vbs"
$line = 'CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' + $run + '""", 0, False'
Set-Content -Path $vbs -Value $line -Encoding ASCII
Start-Process wscript.exe -ArgumentList "`"$vbs`""
Write-Host "Installed: $vbs"
Write-Host "Started. Dashboard: http://localhost:8787  Logs: $(Join-Path (Split-Path -Parent $PSScriptRoot) 'logs')"
