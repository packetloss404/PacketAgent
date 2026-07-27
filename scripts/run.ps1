# One-step launcher for PacketAgent (Windows PowerShell).
# Installs dependencies on first run, loads .env, checks for an AI provider,
# opens the browser, and starts the dev server.

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptRoot
Set-Location $projectRoot

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies (one-time, ~1 minute)..."
    npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (Test-Path ".env") {
    Get-Content ".env" | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq "" -or $line.StartsWith("#")) { return }
        $eq = $line.IndexOf("=")
        if ($eq -lt 1) { return }
        $name = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1).Trim()
        # Strip optional surrounding quotes.
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
}

node scripts/preflight.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Opening http://localhost:7341/builder in your browser..."
Start-Job -ScriptBlock {
    Start-Sleep -Seconds 3
    Start-Process "http://localhost:7341/builder"
} | Out-Null

npm run dev
