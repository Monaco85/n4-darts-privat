<# : n4-darts unter Windows starten (Doppelklick genuegt): Server, Oberflaeche und zwei simulierte Boards
@echo off
title n4-darts
powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:N4_ROOT='%~dp0'; iex ((Get-Content -LiteralPath '%~f0') -join [char]10)"
echo.
pause
exit /b
#>
$ErrorActionPreference = 'Stop'
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }
function Step($t) { Write-Host ''; Write-Host "==> $t" -ForegroundColor Cyan }

try {
  Set-Location $env:N4_ROOT

  Step 'Pruefe Node.js'
  $major = 0
  if (Get-Command node -ErrorAction SilentlyContinue) { $major = [int]((node -v).TrimStart('v').Split('.')[0]) }
  if ($major -lt 22) {
    Write-Host "Node.js 22+ fehlt (gefunden: $major). Installiere Node.js LTS ueber winget ..."
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    Refresh-Path
    $major = [int]((node -v).TrimStart('v').Split('.')[0])
    if ($major -lt 22) { throw 'Node.js konnte nicht installiert werden. Bitte von https://nodejs.org die LTS-Version installieren und erneut starten.' }
  }
  Write-Host "Node.js $(node -v) ok"

  if (-not (Test-Path 'packages\web\node_modules\vite\bin\vite.js')) {
    Step 'Installiere Abhaengigkeiten (dauert beim ersten Mal 1-2 Minuten)'
    & npx.cmd -y pnpm@12.14.0 install
    if ($LASTEXITCODE -ne 0) { throw 'pnpm install ist fehlgeschlagen (Meldungen oben).' }
  }

  Step 'Starte Server, Oberflaeche und zwei simulierte Boards'
  & node scripts\n4-start.mjs
} catch {
  Write-Host ''
  Write-Host "FEHLER: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Bitte einen Screenshot dieses Fensters an Claude schicken.'
}
