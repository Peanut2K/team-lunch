# Quick status from the terminal (same data as the dashboard).
try { Invoke-RestMethod http://localhost:8787/health | ConvertTo-Json -Depth 5 }
catch { Write-Host "agent-runner is not running (try: .\daemon\install.ps1)" }
