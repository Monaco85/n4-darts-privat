# n4-darts (Paket): startet den Server und, wenn gewuenscht, das simulierte Board.
# Wird von "Darts starten.cmd" (echtes Board) und "Darts Simulator.cmd" (-Simulator) aufgerufen.
# Braucht nur Node.js 22 oder neuer; alles andere liegt im Paket.
param([switch]$Simulator)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root
try { Start-Transcript -Path (Join-Path $root 'n4-start.log') -Force | Out-Null } catch {}

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
    [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Step($text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Red }

$procs = @()
try {
  Step 'Pruefe Node.js'
  $major = 0
  if (Get-Command node -ErrorAction SilentlyContinue) {
    $major = [int]((node -v).TrimStart('v').Split('.')[0])
  }
  if ($major -lt 22) {
    Write-Host "Node.js 22+ fehlt (gefunden: $major). Installiere Node.js LTS ueber winget ..."
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    Refresh-Path
    $major = [int]((node -v).TrimStart('v').Split('.')[0])
    if ($major -lt 22) {
      throw 'Node.js konnte nicht installiert werden. Bitte von https://nodejs.org die LTS-Version installieren und erneut starten.'
    }
  }
  Write-Host "Node.js $(node -v) ok"

  if ($Simulator) {
    $board = 'http://localhost:3180'
  } else {
    Write-Host ''
    Write-Host 'Adresse des PCs, auf dem Autodarts laeuft.'
    Write-Host 'Einfach Enter druecken, wenn es dieser PC ist (http://localhost:3180).'
    Write-Host 'Sonst z. B. 192.168.178.50 eingeben.'
    $board = (Read-Host 'Adresse').Trim()
    if (-not $board) { $board = 'http://localhost:3180' }
    if ($board -notmatch '^https?://') { $board = "http://$board" }
    if ($board -notmatch ':\d+/?$') { $board = $board.TrimEnd('/') + ':3180' }
  }

  $env:DATA_DIR = Join-Path $root 'data'
  $env:WEB_DIR = Join-Path $root 'web'
  $env:STATIONS = "1=$board"
  $env:MAX_STATIONS = '1'
  $env:PORT = '3000'

  if ($Simulator) {
    Step 'Starte das simulierte Board (Port 3180)'
    $procs += Start-Process -FilePath 'node' -ArgumentList '"sim.mjs" --boards 1' -WorkingDirectory $root -NoNewWindow -PassThru
  }

  Step "Starte n4-darts fuer das Board unter $board"
  $procs += Start-Process -FilePath 'node' -ArgumentList '"server.mjs"' -WorkingDirectory $root -NoNewWindow -PassThru

  # Warten, bis der Server antwortet, dann Station 1 auf das Board stellen und den Browser oeffnen.
  $up = $false
  for ($i = 0; $i -lt 60 -and -not $up; $i++) {
    Start-Sleep -Milliseconds 500
    try { $up = (Invoke-WebRequest 'http://localhost:3000/api/health' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch {}
  }
  if (-not $up) { throw 'Der Server ist nicht gestartet (Meldungen oben).' }
  try {
    Invoke-RestMethod -Method Patch -Uri 'http://localhost:3000/api/admin/stations/1' -ContentType 'application/json' `
      -Body (@{ name = 'Station 1'; boardUrl = $board } | ConvertTo-Json) | Out-Null
  } catch {}

  $version = $null
  try { $version = (Invoke-WebRequest "$board/api/version" -UseBasicParsing -TimeoutSec 3).Content.Trim() } catch {}

  Write-Host ''
  Write-Host '================================================' -ForegroundColor Red
  Write-Host ' n4-darts laeuft!' -ForegroundColor White
  Write-Host '  Spielen : http://localhost:3000/station/1'
  if ($Simulator) { Write-Host '  Fake-Board: http://localhost:3180/' }
  elseif ($version) { Write-Host "  Autodarts Board Manager gefunden, Version $version" -ForegroundColor Green }
  else { Write-Host "  ACHTUNG: Unter $board antwortet kein Autodarts Board Manager!" -ForegroundColor Yellow }
  Write-Host "  Stats   : $(Join-Path $env:DATA_DIR 'spieler-stats.json')"
  Write-Host ' Beenden: dieses Fenster schliessen'
  Write-Host '================================================' -ForegroundColor Red
  Start-Process 'http://localhost:3000/station/1'
  if ($Simulator) { Start-Process 'http://localhost:3180/' }

  Wait-Process -Id ($procs | ForEach-Object { $_.Id })
} catch {
  Write-Host ''
  Write-Host "FEHLER: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Bitte einen Screenshot dieses Fensters an Claude schicken.'
} finally {
  foreach ($p in $procs) { try { Stop-Process -Id $p.Id -ErrorAction SilentlyContinue } catch {} }
  try { Stop-Transcript | Out-Null } catch {}
}
