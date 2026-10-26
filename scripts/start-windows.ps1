# n4-darts unter Windows starten. Wird von start-windows.cmd (Simulator) und
# start-echtes-board.cmd (echtes Autodarts-Board, Parameter -EchtesBoard) aufgerufen.
# Alles, was hier passiert, landet zusaetzlich in n4-start.log im n4-darts-Ordner.
param([switch]$EchtesBoard)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
try { Start-Transcript -Path (Join-Path $root 'n4-start.log') -Force | Out-Null } catch {}

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
    [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Step($text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }

try {
  $board = $null
  if ($EchtesBoard) {
    Write-Host ''
    Write-Host 'Adresse des PCs, auf dem Autodarts laeuft.'
    Write-Host 'Einfach Enter druecken, wenn es dieser PC ist (http://localhost:3180).'
    Write-Host 'Sonst z. B. 192.168.178.50 eingeben.'
    $board = (Read-Host 'Adresse').Trim()
    if (-not $board) { $board = 'http://localhost:3180' }
    if ($board -notmatch '^https?://') { $board = "http://$board" }
    if ($board -notmatch ':\d+/?$') { $board = $board.TrimEnd('/') + ':3180' }
  }

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

  # Neu installieren, wenn noch nichts da ist oder sich pnpm-lock.yaml geaendert hat (z. B. nach git pull).
  $lock = (Get-FileHash 'pnpm-lock.yaml').Hash
  $mark = 'node_modules\.n4-lock'
  $installed = if (Test-Path $mark) { (Get-Content $mark -Raw).Trim() } else { '' }
  $font = 'packages\web\node_modules\@fontsource-variable\inter\package.json'
  $fontMissing = -not (Test-Path $font)
  if (-not (Test-Path 'packages\web\node_modules\vite\bin\vite.js') -or $installed -ne $lock -or $fontMissing) {
    Write-Host ''
    Write-Host '  +------------------------------------------------------------+' -ForegroundColor Yellow
    if ($fontMissing) {
      Write-Host '  |  Neue Schrift (Inter) und Pakete werden installiert ...    |' -ForegroundColor Yellow
    } else {
      Write-Host '  |  Neue Pakete werden installiert ...                        |' -ForegroundColor Yellow
    }
    Write-Host '  |  Das dauert 1-2 Minuten. Bitte das Fenster offen lassen.   |' -ForegroundColor Yellow
    Write-Host '  +------------------------------------------------------------+' -ForegroundColor Yellow
    Write-Host ''
    $watch = [Diagnostics.Stopwatch]::StartNew()
    & npx.cmd -y pnpm@12.14.0 install
    if ($LASTEXITCODE -ne 0) { throw 'pnpm install ist fehlgeschlagen (Meldungen oben).' }
    Set-Content -LiteralPath $mark -Value $lock -Encoding ASCII
    if (Test-Path $font) {
      Write-Host "  [OK] Schrift Inter installiert ($([int]$watch.Elapsed.TotalSeconds) s)" -ForegroundColor Green
    } else {
      Write-Host '  [!] Schrift Inter fehlt noch - die Oberflaeche nutzt solange eine Ersatzschrift.' -ForegroundColor Yellow
    }
  } else {
    Write-Host '  [OK] Schrift und Pakete sind aktuell' -ForegroundColor Green
  }

  if ($board) {
    Step "Starte Server und Oberflaeche fuer das echte Board unter $board"
    & node scripts\n4-start.mjs --board $board
  } else {
    Step 'Starte Server, Oberflaeche und zwei simulierte Boards'
    & node scripts\n4-start.mjs
  }
} catch {
  Write-Host ''
  Write-Host "FEHLER: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Bitte einen Screenshot dieses Fensters an Claude schicken.'
} finally {
  try { Stop-Transcript | Out-Null } catch {}
}
