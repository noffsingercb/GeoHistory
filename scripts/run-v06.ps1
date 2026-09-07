<#
GeoHistory v0.6 build runner (Windows PowerShell 5.1 or PowerShell 7).
Runs each step, stops at the FIRST failing step, logs every step to .\logs\<stamp>-<step>.log.

  .\scripts\run-v06.ps1 -Dump "D:\wikidata\latest-all.json.gz" -Check   # validate dump + db only (seconds)
  .\scripts\run-v06.ps1 -Dump "D:\wikidata\latest-all.json.gz" -Slice   # 2M-line slice: ingest, post-ingest, diag (minutes)
  .\scripts\run-v06.ps1 -Dump "D:\wikidata\latest-all.json.gz" -Full    # the real run (hours), then post-ingest + diag
  .\scripts\run-v06.ps1 -PostIngestOnly                                  # re-run post-ingest + diag on the current events.sqlite

If PowerShell refuses to run scripts:  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
#>
param(
  [string]$Dump = $env:WIKIDATA_DUMP,
  [switch]$Check,
  [switch]$Slice,
  [switch]$Full,
  [switch]$PostIngestOnly,
  [int]$SliceLines = 2000000,
  [string]$Db = 'events.sqlite'
)
$ErrorActionPreference = 'Continue'   # npm writes warnings to stderr; exit codes are checked explicitly below
Set-Location (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
New-Item -ItemType Directory -Force -Path logs, diagnostics | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'

function Step([string]$Name, [string]$Cmd) {
  $log = "logs\$stamp-$Name.log"
  Write-Host "`n=== $Name   ($Cmd)   log: $log" -ForegroundColor Cyan
  $t = Get-Date
  cmd /c "$Cmd 2>&1" | Tee-Object -FilePath $log
  $code = $LASTEXITCODE
  $took = (Get-Date) - $t
  if ($code -eq 0) { Write-Host ("=== $Name OK in {0:hh\:mm\:ss}" -f $took) -ForegroundColor Green }
  else { Write-Host ("=== $Name FAILED (exit $code) after {0:hh\:mm\:ss}. STOPPING. See $log" -f $took) -ForegroundColor Red; exit $code }
}

if (-not ($Check -or $Slice -or $Full -or $PostIngestOnly)) { Write-Host 'Pick one of -Check, -Slice, -Full, -PostIngestOnly.' -ForegroundColor Red; exit 1 }
if (-not $PostIngestOnly) {
  if (-not $Dump) { Write-Host 'Pass -Dump <path to latest-all.json.gz> (or set $env:WIKIDATA_DUMP first).' -ForegroundColor Red; exit 1 }
  if (-not (Test-Path -LiteralPath $Dump -PathType Leaf)) { Write-Host "Dump not found: $Dump" -ForegroundColor Red; exit 1 }
  $env:WIKIDATA_DUMP = (Resolve-Path -LiteralPath $Dump).Path
  Write-Host "Dump: $env:WIKIDATA_DUMP ($([math]::Round((Get-Item -LiteralPath $env:WIKIDATA_DUMP).Length / 1GB, 1)) GB)"
}
$env:GEOHISTORY_DB = $Db
Remove-Item Env:INGEST_MAX_LINES -ErrorAction SilentlyContinue

Step 'typecheck' 'npx tsc --noEmit'
if ($Check) { Step 'ingest-check' 'npm run ingest:check'; Write-Host "`nCheck passed. Nothing was written." -ForegroundColor Green; exit 0 }

if ($Slice -or $Full) {
  Step 'ingest-check' 'npm run ingest:check'
  if (Test-Path $Db) {
    $aside = "$Db.before-$stamp"
    Write-Host "Existing $Db moved aside -> $aside" -ForegroundColor Yellow
    Move-Item $Db $aside
    Remove-Item "$Db-wal", "$Db-shm" -ErrorAction SilentlyContinue
  }
  if ($Slice) { $env:INGEST_MAX_LINES = "$SliceLines"; Write-Host "SLICE: first $SliceLines lines per pass" -ForegroundColor Yellow }
  else { Write-Host 'FULL RUN: several hours. Keep the PC awake (Settings > Power > Sleep: Never, or powercfg /change standby-timeout-ac 0).' -ForegroundColor Yellow }
  Step 'ingest-dump' 'npm run ingest:dump'
  Remove-Item Env:INGEST_MAX_LINES -ErrorAction SilentlyContinue
  $raw = if ($Slice) { 'events.slice-raw.sqlite' } else { 'events.v06-raw.sqlite' }
  Copy-Item $Db $raw -Force
  Write-Host "Raw ingest saved as $raw -- post-ingest can be re-run from this copy without re-ingesting." -ForegroundColor Green
}

Step 'post-ingest' 'npm run post-ingest'
$diag = if ($Slice) { "diagnostics\slice-$stamp.txt" } else { "diagnostics\v06-$stamp.txt" }
cmd /c 'npm run diag 2>&1' | Out-File -FilePath $diag -Encoding utf8
Write-Host "diag -> $diag (UTF-8; attach it to the Notion plan page)" -ForegroundColor Green
Write-Host "`nDONE. Step logs: .\logs\$stamp-*.log" -ForegroundColor Green
