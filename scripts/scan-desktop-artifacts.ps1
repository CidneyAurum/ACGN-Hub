param([string]$EvidenceName = '')

$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$config = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $taskRoot 'src-tauri\tauri.conf.json') | ConvertFrom-Json
$version = [string]$config.version
$productName = [string]$config.productName
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { throw 'Invalid application version.' }
if ([string]::IsNullOrWhiteSpace($productName) -or $productName -match '[\x00-\x1f<>:"/\\|?*]') { throw 'Invalid product name.' }
if ([string]::IsNullOrWhiteSpace($EvidenceName)) {
    $versionTag = $version -replace '[^0-9A-Za-z-]', ''
    $EvidenceName = "v$versionTag-manga-final-scan"
}
if ($EvidenceName -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]{0,119}$') { throw 'EvidenceName must be a simple file-name stem.' }
$evidenceDirectory = Join-Path $taskRoot '.work\security-audit'
$evidence = Join-Path $evidenceDirectory ($EvidenceName + '.json')
if (Test-Path -LiteralPath $evidence) { throw 'Scan evidence already exists; preserve the previous record.' }
New-Item -ItemType Directory -Force -Path $evidenceDirectory | Out-Null

$protection = Get-MpComputerStatus
if (-not $protection.AntivirusEnabled -or -not $protection.RealTimeProtectionEnabled) { throw 'Defender must remain enabled.' }
$platform = Get-ChildItem -LiteralPath (Join-Path $env:ProgramData 'Microsoft\Windows Defender\Platform') -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (-not $platform) { throw 'Defender platform was not found.' }
$scanner = Join-Path $platform.FullName 'MpCmdRun.exe'
if ((Get-AuthenticodeSignature -LiteralPath $scanner).Status -ne 'Valid') { throw 'Defender scanner signature is not valid.' }
$files = @(
    (Join-Path $taskRoot 'src-tauri\target\release\acgn-hub.exe'),
    (Join-Path $taskRoot ("src-tauri\target\release\bundle\nsis\{0}_{1}_x64-setup.exe" -f $productName, $version))
)
foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Build artifact is missing: $file" }
    $productVersion = [string](Get-Item -LiteralPath $file).VersionInfo.ProductVersion
    if ([string]::IsNullOrWhiteSpace($productVersion) -or $productVersion -ne $version) {
        throw "Build artifact version does not match tauri.conf.json ($version): $file ($productVersion)"
    }
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
$results = @()
foreach ($file in $files) {
    $protection = Get-MpComputerStatus
    if (-not $protection.AntivirusEnabled -or -not $protection.RealTimeProtectionEnabled) { throw 'Defender must remain enabled.' }
    $item = Get-Item -LiteralPath $file
    $beforeHash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    $started = Get-Date
    $output = @(& $scanner -Scan -ScanType 3 -File $file 2>&1 | ForEach-Object { $_.ToString() })
    $scanCode = $LASTEXITCODE
    $events = @()
    try {
        $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Windows Defender/Operational'; Id = 1116, 1117; StartTime = $started } -ErrorAction Stop | ForEach-Object {
            [ordered]@{ id = $_.Id; time = $_.TimeCreated.ToUniversalTime().ToString('o') }
        })
    } catch {
        if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw }
    }
    $present = Test-Path -LiteralPath $file -PathType Leaf
    $afterHash = if ($present) { (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash } else { $null }
    $afterProtection = Get-MpComputerStatus
    $results += [ordered]@{
        path = $file
        product = $productName
        version = $version
        sizeBytes = $item.Length
        sha256BeforeScan = $beforeHash
        sha256 = $afterHash
        artifactPresentAfterScan = $present
        scanStarted = $started.ToUniversalTime().ToString('o')
        scanFinished = (Get-Date).ToUniversalTime().ToString('o')
        scanExitCode = $scanCode
        scanOutput = $output
        newDetectionEvents = $events
        antivirusEnabled = [bool]$afterProtection.AntivirusEnabled
        realTimeProtectionEnabled = [bool]$afterProtection.RealTimeProtectionEnabled
        executedApplication = $false
        installedNsis = $false
    }
    [IO.File]::WriteAllText($evidence, (ConvertTo-Json -InputObject @($results) -Depth 6), $utf8)
    if ($scanCode -ne 0 -or $events.Count -gt 0 -or ($output -join ' ') -notmatch 'found no threats' -or
        -not $present -or $beforeHash -ne $afterHash -or
        -not $afterProtection.AntivirusEnabled -or -not $afterProtection.RealTimeProtectionEnabled) {
        throw 'Artifact scan did not pass; application execution stopped. Evidence was preserved.'
    }
}
$results | ForEach-Object { [pscustomobject]@{ path = $_.path; version = $_.version; sha256 = $_.sha256; scanExitCode = $_.scanExitCode } } | ConvertTo-Json
