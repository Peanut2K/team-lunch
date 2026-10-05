# Starts the tunnel (ngrok) and the agent-runner, restarting the runner if it crashes.
# Launched hidden at Windows logon by install.ps1. Logs: agent-runner\logs\
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path (Join-Path $root "logs") | Out-Null

function Get-EnvValue($name, $default) {
  $line = Get-Content (Join-Path $root ".env") -ErrorAction SilentlyContinue | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
  if ($line) { return ($line -replace "^$name=", "").Trim() } else { return $default }
}

$port = Get-EnvValue "PORT" "8787"
$publicUrl = Get-EnvValue "PUBLIC_URL" ""

if ($publicUrl -and -not (Get-Process ngrok -ErrorAction SilentlyContinue)) {
  $domain = ([Uri]$publicUrl).Host
  $ngrokLog = Join-Path $root "logs\ngrok.log"
  Start-Process ngrok -ArgumentList @("http", "--url=$domain", $port, "--log=$ngrokLog") -WindowStyle Hidden
}

$runnerLog = Join-Path $root "logs\daemon.log"
while ($true) {
  Add-Content $runnerLog "$(Get-Date -Format o) starting agent-runner"
  & node --env-file=.env src/server.mjs *>> $runnerLog
  Add-Content $runnerLog "$(Get-Date -Format o) agent-runner exited ($LASTEXITCODE), restarting in 5s"
  Start-Sleep -Seconds 5
}
