# Stop agent-runner + ngrok and remove the logon startup entry.
$vbs = Join-Path ([Environment]::GetFolderPath("Startup")) "team-lunch-agent-runner.vbs"
Remove-Item $vbs -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -and ($_.CommandLine -like "*agent-runner*run.ps1*" -or $_.CommandLine -like "*src/server.mjs*") } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "Stopped and removed from startup."
