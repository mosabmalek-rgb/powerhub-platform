$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$workspace = $env:GITHUB_WORKSPACE
if ([string]::IsNullOrWhiteSpace($workspace)) {
  throw 'GITHUB_WORKSPACE is not set.'
}

$tempRoot = Join-Path $env:RUNNER_TEMP 'powerhub-postgres17'
$archivePath = Join-Path $tempRoot 'postgresql-17.11-4-windows-x64-binaries.zip'
$extractRoot = Join-Path $tempRoot 'extract'
$dataPath = Join-Path $tempRoot 'data'
$logPath = Join-Path $tempRoot 'postgres.log'
$downloadUrl = 'https://get.enterprisedb.com/postgresql/postgresql-17.11-4-windows-x64-binaries.zip'
$expectedSha256 = 'b9424ee7bc60b52450ff910a3630225df32e633f3cb29c1d126d9299d59aea28'
$pgCtl = $null
$serverStarted = $false

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null

try {
  Write-Output 'POSTGRES17_DOWNLOAD_STARTED'
  Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath -UseBasicParsing
  $actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) {
    throw "PostgreSQL binary archive SHA-256 mismatch. Expected $expectedSha256, got $actualSha256"
  }
  Write-Output "POSTGRES17_ARCHIVE_SHA256_VERIFIED=$actualSha256"

  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
  $initDbItem = Get-ChildItem -LiteralPath $extractRoot -Filter 'initdb.exe' -File -Recurse | Select-Object -First 1
  if ($null -eq $initDbItem) { throw 'initdb.exe was not found in the verified PostgreSQL archive.' }

  $pgBin = Split-Path -Parent $initDbItem.FullName
  $pgRoot = Split-Path -Parent $pgBin
  $pgCtl = Join-Path $pgBin 'pg_ctl.exe'
  $psql = Join-Path $pgBin 'psql.exe'
  $createdb = Join-Path $pgBin 'createdb.exe'
  $postgres = Join-Path $pgBin 'postgres.exe'

  foreach ($path in @($pgCtl, $psql, $createdb, $postgres)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Required PostgreSQL binary is missing: $path" }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $pgRoot 'share'))) {
    throw "PostgreSQL share directory was not found at $pgRoot."
  }

  $env:PATH = "$pgBin;$(Join-Path $pgRoot 'lib');$env:PATH"
  $env:PGHOST = '127.0.0.1'
  $env:PGPORT = '55432'
  $env:PGUSER = 'postgres'
  $env:PGCLIENTENCODING = 'UTF8'

  Write-Output 'POSTGRES17_INITDB_STARTED'
  & $initDbItem.FullName -D $dataPath -U postgres -A trust -E UTF8
  if ($LASTEXITCODE -ne 0) { throw "initdb exited with code $LASTEXITCODE." }

  Write-Output 'POSTGRES17_START_STARTED'
  & $pgCtl -D $dataPath -l $logPath -o '-h 127.0.0.1 -p 55432' -w start
  if ($LASTEXITCODE -ne 0) {
    if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Tail 120 }
    throw "pg_ctl start exited with code $LASTEXITCODE."
  }
  $serverStarted = $true

  $versionRows = & $psql -d postgres -v ON_ERROR_STOP=1 -A -t -c 'select version();'
  if ($LASTEXITCODE -ne 0) { throw 'Could not query the temporary PostgreSQL instance.' }
  Write-Output "POSTGRES17_SERVER_VERSION=$($versionRows -join ' ')"

  $fixtures = @(
    @{ Database = 'powerhub_reading_cycle_test'; File = 'supabase/tests/reading_cycle_boundary_audit_fix.sql' },
    @{ Database = 'powerhub_tariff_test'; File = 'supabase/tests/tariff_price_history_migration.sql' },
    @{ Database = 'powerhub_invoice_sms_test'; File = 'supabase/tests/invoice_bulk_sms_safety.sql' },
    @{ Database = 'powerhub_dashboard_kpi_test'; File = 'supabase/tests/dashboard_all_branch_kpis.sql' },
    @{ Database = 'powerhub_message_history_test'; File = 'supabase/tests/unified_message_history_filters.sql' },
    @{ Database = 'powerhub_site_billing_test'; File = 'supabase/tests/site_billing_policy_integration.sql' }
  )

  foreach ($fixture in $fixtures) {
    $testFile = Join-Path $workspace $fixture.File
    if (-not (Test-Path -LiteralPath $testFile)) { throw "SQL fixture is missing: $testFile" }

    Write-Output "POSTGRES17_FIXTURE_START=$($fixture.File)"
    & $createdb $fixture.Database
    if ($LASTEXITCODE -ne 0) { throw "createdb failed for $($fixture.Database) with exit code $LASTEXITCODE." }

    & $psql -d $fixture.Database -v ON_ERROR_STOP=1 --file $testFile
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL 17 fixture failed: $($fixture.File) (exit $LASTEXITCODE)." }
    Write-Output "POSTGRES17_FIXTURE_PASSED=$($fixture.File)"
  }

  Write-Output 'POSTGRES17_ALL_SQL_FIXTURES_PASSED'
}
finally {
  if ($serverStarted -and $null -ne $pgCtl) {
    & $pgCtl -D $dataPath -m fast -w stop
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "pg_ctl stop returned exit code $LASTEXITCODE."
    }
  }
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
