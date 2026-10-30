# Passive native UIAutomation observation. This script never navigates, focuses,
# restores, refreshes, changes the clock, or invokes an application control.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9-]+$')]
    [string]$Session,
    [ValidateRange(35, 240)]
    [int]$DurationMinutes = 35,
    [ValidateRange(10, 60)]
    [int]$PollSeconds = 30,
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ExpectedSortingLabel,
    [switch]$KeepAwake
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Passive native observation requires Windows.' }
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sessionRoot = Join-Path $taskRoot ('.work\v03-evidence\' + $Session)
$launchPath = Join-Path $sessionRoot 'launch.json'
$helperPath = Join-Path $PSScriptRoot 'normal-ui-verification.ps1'
if (-not (Test-Path -LiteralPath $launchPath -PathType Leaf)) { throw 'An existing native launch.json is required; the observer never starts the app.' }
if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) { throw 'The passive native verification helper is missing.' }
$launch = Get-Content -Raw -Encoding UTF8 -LiteralPath $launchPath | ConvertFrom-Json
$observedProcessId = [int]$launch.pid
if ($observedProcessId -le 0) { throw 'The launch record has no valid application PID.' }
$nativeProcess = Get-Process -Id $observedProcessId -ErrorAction SilentlyContinue
if (-not $nativeProcess) { throw 'The application in the launch record is no longer running.' }
$processStartedUtc = $nativeProcess.StartTime.ToUniversalTime().ToString('o')
$observationId = 'refresh-observation-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$outputRoot = Join-Path $sessionRoot $observationId
if (Test-Path -LiteralPath $outputRoot) { throw 'Observation evidence already exists; refusing to overwrite it.' }
New-Item -ItemType Directory -Path $outputRoot | Out-Null
$powershellExe = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path -LiteralPath $powershellExe -PathType Leaf)) { $powershellExe = (Get-Command powershell.exe -ErrorAction Stop).Source }
$clock = New-Object System.Diagnostics.Stopwatch
$samples = New-Object 'System.Collections.Generic.List[object]'
$startedUtc = [DateTime]::UtcNow
$firstFooterUtc = $null
$initialSortingValue = $null
$failure = $null
$awakeRequested = $false
$awakeReleased = $null
$passed = $false
$footerPrefix = [regex]::Unescape('\u66f4\u65b0\u4e8e')
$category = [regex]::Replace($ExpectedSortingLabel, '\u63a8\u8350\u6392\u5e8f$', '')
$refreshLabel = [regex]::Unescape('\u5237\u65b0') + $category + [regex]::Unescape('\u63a8\u8350')
$discoveryFailurePattern = '\u7f51\u7edc\u6682\u4e0d\u53ef\u7528|\u6682\u65f6\u672a\u80fd\u52a0\u8f7d|\u52a0\u8f7d\u5931\u8d25|\u65e0\u6cd5\u66f4\u65b0'

function Write-NewJson {
    param([string]$Path, [object]$Value)
    $body = ($Value | ConvertTo-Json -Depth 12) + [Environment]::NewLine
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($body)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
}

function Parse-FooterTime {
    param([string]$Label)
    $text = $Label.Substring($footerPrefix.Length).Trim()
    $text = [regex]::Replace($text, '\s*\u00b7.*$', '').Trim()
    if ($text -notmatch '\d{1,2}:\d{2}') { return $null }
    foreach ($culture in @([Globalization.CultureInfo]::GetCultureInfo('zh-CN'), [Globalization.CultureInfo]::CurrentCulture, [Globalization.CultureInfo]::GetCultureInfo('en-US'), [Globalization.CultureInfo]::InvariantCulture)) {
        $parsed = [DateTime]::MinValue
        if ([DateTime]::TryParse($text, $culture, [Globalization.DateTimeStyles]::AssumeLocal, [ref]$parsed)) { return $parsed.ToUniversalTime() }
    }
    return $null
}

function Read-PassiveSample {
    param([int]$Index)
    $sampleId = 'sample-' + $Index.ToString('D5') + '-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
    $stdoutPath = Join-Path $outputRoot ($sampleId + '.helper.stdout.log')
    $stderrPath = Join-Path $outputRoot ($sampleId + '.helper.stderr.log')
    $rawPath = Join-Path $outputRoot ($sampleId + '.accessibility.json')
    $samplePath = Join-Path $outputRoot ($sampleId + '.json')
    $beforeUtc = [DateTime]::UtcNow
    $helperExit = $null
    $helperError = $null
    $rawCopied = $false
    $rows = @()
    $child = $null
    try {
        $arguments = @('-NoProfile', '-File', ('"' + $helperPath + '"'), '-Session', $Session, '-TargetProcessId', [string]$observedProcessId, '-Action', 'Snapshot', '-Passive')
        $child = Start-Process -FilePath $powershellExe -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        # Keep the process handle alive before it exits. Windows PowerShell 5
        # can otherwise lose ExitCode for short redirected child processes.
        $null = $child.Handle
        if (-not $child.WaitForExit(30000)) {
            # Only the observer's own helper is stopped on timeout. The native
            # app PID is never closed, killed, or otherwise controlled.
            Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
            $helperError = 'Passive helper exceeded 30 seconds.'
        } else {
            $helperExit = $child.ExitCode
            if ($helperExit -ne 0) { $helperError = 'Passive helper returned a nonzero exit code.' }
        }
        if ($helperExit -eq 0 -and -not $helperError) {
            $lastSnapshot = Join-Path $sessionRoot 'last-accessibility.json'
            if (-not (Test-Path -LiteralPath $lastSnapshot -PathType Leaf)) { throw 'The passive helper did not produce accessibility JSON.' }
            if ((Get-Item -LiteralPath $lastSnapshot).LastWriteTimeUtc -lt $beforeUtc.AddSeconds(-1)) { throw 'The helper snapshot is older than this sample.' }
            [IO.File]::Copy($lastSnapshot, $rawPath, $false)
            $rawCopied = $true
            # ConvertFrom-Json on Windows PowerShell 5 emits a JSON array as a
            # single pipeline object. Assign it before enumerating its rows.
            $parsedRows = Get-Content -Raw -Encoding UTF8 -LiteralPath $rawPath | ConvertFrom-Json
            $rows = @($parsedRows | ForEach-Object { $_ })
        }
    } catch { $helperError = $_.Exception.Message }
    finally { if ($child) { $child.Dispose() } }
    $observedUtc = [DateTime]::UtcNow
    $process = Get-Process -Id $observedProcessId -ErrorAction SilentlyContinue
    $alive = $null -ne $process
    $sameProcess = $alive -and $process.StartTime.ToUniversalTime().ToString('o') -eq $processStartedUtc
    $sameLaunch = $false
    try {
        $currentLaunch = Get-Content -Raw -Encoding UTF8 -LiteralPath $launchPath | ConvertFrom-Json
        $sameLaunch = [int]$currentLaunch.pid -eq $observedProcessId -and $currentLaunch.profile -eq $launch.profile -and $currentLaunch.executable -eq $launch.executable
    } catch { if (-not $helperError) { $helperError = 'The native launch record became unreadable.' } }
    $sorting = @($rows | Where-Object { $_.name -eq $ExpectedSortingLabel -and $_.type -eq 'ControlType.ComboBox' })
    $sortingValue = if ($sorting.Count -eq 1 -and $null -ne $sorting[0].value) { [string]$sorting[0].value } else { $null }
    $sortingValueAvailable = -not [string]::IsNullOrWhiteSpace($sortingValue)
    $sameSortingValue = $sortingValueAvailable -and ($Index -eq 0 -or $sortingValue -ceq $initialSortingValue)
    $refresh = @($rows | Where-Object { $_.name -eq $refreshLabel -and $_.type -eq 'ControlType.Button' })
    $visibleNames = @($rows | Where-Object { $_.name -and -not $_.offscreen } | ForEach-Object { [string]$_.name } | Select-Object -Unique)
    $footerLabels = @($visibleNames | Where-Object { $_.StartsWith($footerPrefix) })
    $footerUtc = $null
    if ($footerLabels.Count -eq 1) { $footerUtc = Parse-FooterTime $footerLabels[0] }
    $discoveryFailures = @($visibleNames | Where-Object { $_ -match $discoveryFailurePattern })
    $visibleIssues = @($visibleNames | Where-Object { $_ -match '\u5f02\u5e38|\u9519\u8bef|\u5931\u8d25|\u8d85\u65f6|\u6682\u4e0d\u53ef\u7528' })
    $sample = [pscustomobject][ordered]@{
        index = $Index; observedAtUtc = $observedUtc.ToString('o'); elapsedSeconds = $clock.Elapsed.TotalSeconds
        pid = $observedProcessId; alive = $alive; sameProcess = $sameProcess; sameLaunchProfile = $sameLaunch
        helperExitCode = $helperExit; helperError = $helperError; rawAccessibility = $(if ($rawCopied) { $rawPath } else { $null })
        helperStdout = $stdoutPath; helperStderr = $stderrPath
        expectedSortingLabel = $ExpectedSortingLabel; sortingControlCount = $sorting.Count
        sortingValue = $sortingValue; sortingValueAvailable = $sortingValueAvailable; sameSortingValue = $sameSortingValue
        sortingEnabled = $sorting.Count -eq 1 -and [bool]$sorting[0].enabled
        sortingOffscreen = $(if ($sorting.Count -eq 1) { [bool]$sorting[0].offscreen } else { $null })
        refreshLabel = $refreshLabel; refreshControlCount = $refresh.Count
        refreshEnabled = $(if ($refresh.Count -eq 1) { [bool]$refresh[0].enabled } else { $null })
        footerLabels = $footerLabels; footerTimestampUtc = $(if ($footerUtc) { $footerUtc.ToString('o') } else { $null })
        footerAgeSeconds = $(if ($footerUtc) { ($observedUtc - $footerUtc).TotalSeconds } else { $null })
        footerMentionsCache = @($footerLabels | Where-Object { $_ -match '\u7f13\u5b58' }).Count -gt 0
        discoveryFailureLabels = $discoveryFailures; visibleIssueLabels = $visibleIssues
        valid = -not $helperError -and $helperExit -eq 0 -and $sameProcess -and $sameLaunch -and $sorting.Count -eq 1 -and $sameSortingValue -and $refresh.Count -eq 1 -and $null -ne $footerUtc
    }
    Write-NewJson -Path $samplePath -Value $sample
    $samples.Add($sample)
    Write-Output ($sample | Select-Object index, observedAtUtc, elapsedSeconds, valid, sortingValue, footerLabels, refreshEnabled, helperExitCode, helperError | ConvertTo-Json -Compress -Depth 4)
    return $sample
}

try {
    if ($KeepAwake) {
        if (-not ('AcgnPassiveDiscoveryPower' -as [type])) {
            Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AcgnPassiveDiscoveryPower {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern UInt32 SetThreadExecutionState(UInt32 flags);
}
'@
        }
        if ([AcgnPassiveDiscoveryPower]::SetThreadExecutionState([uint32]2147483651) -eq 0) { throw 'The current-process keep-awake request failed.' }
        $awakeRequested = $true
    }
    Write-NewJson -Path (Join-Path $outputRoot 'run.json') -Value ([ordered]@{
        startedAtUtc = $startedUtc.ToString('o'); session = $Session; pid = $observedProcessId; processStartedAtUtc = $processStartedUtc
        launch = $launch; durationMinutes = $DurationMinutes; pollSeconds = $PollSeconds; expectedSortingLabel = $ExpectedSortingLabel
        localTimeZone = [TimeZoneInfo]::Local.Id; passive = $true; keepAwake = [bool]$KeepAwake
        helperAction = 'Snapshot'; changesAppControls = $false; changesSystemClock = $false; cdp = $false; injectedJavaScript = $false
    })
    $initialOutput = @(Read-PassiveSample -Index 0)
    $initial = $samples[0]
    $initialOutput | Where-Object { $_ -is [string] } | Write-Output
    if (-not $initial.valid) { throw 'Preflight requires the expected book sorting control with a readable value and a single visible, parseable update footer in this existing native session.' }
    if ($initial.footerAgeSeconds -lt -60 -or $initial.footerAgeSeconds -gt 120) { throw 'Preflight update time must be fresh: no more than 120 seconds old, allowing at most 60 seconds of clock skew.' }
    if ($initial.discoveryFailureLabels.Count -gt 0) { throw 'Preflight shows a discovery failure/cache fallback; refresh it manually before starting a new observation.' }
    $firstFooterUtc = [DateTime]::Parse($initial.footerTimestampUtc).ToUniversalTime()
    $initialSortingValue = $initial.sortingValue
    $clock.Start()
    $index = 1
    while ($clock.Elapsed.TotalMinutes -lt $DurationMinutes) {
        $nextSampleSeconds = [Math]::Min($index * $PollSeconds, $DurationMinutes * 60)
        $waitMilliseconds = [int][Math]::Max(1, ($nextSampleSeconds - $clock.Elapsed.TotalSeconds) * 1000)
        Start-Sleep -Milliseconds $waitMilliseconds
        $sampleOutput = @(Read-PassiveSample -Index $index)
        $sampleOutput | Where-Object { $_ -is [string] } | Write-Output
        $index++
        if (-not $samples[$samples.Count - 1].sameProcess) { throw 'The original native process exited or its PID was reused; no recovery was attempted.' }
    }
} catch {
    $failure = $_.Exception.Message
} finally {
    $clock.Stop()
    if ($awakeRequested) {
        $awakeReleased = [AcgnPassiveDiscoveryPower]::SetThreadExecutionState([uint32]2147483648) -ne 0
        if (-not $awakeReleased -and -not $failure) { $failure = 'The current-process keep-awake request could not be released.' }
    }
    $endedUtc = [DateTime]::UtcNow
    $last = if ($samples.Count) { $samples[$samples.Count - 1] } else { $null }
    $footerAdvanceSeconds = $null
    if ($firstFooterUtc -and $last -and $last.footerTimestampUtc) { $footerAdvanceSeconds = ([DateTime]::Parse($last.footerTimestampUtc).ToUniversalTime() - $firstFooterUtc).TotalSeconds }
    $interventions = @()
    $interactionLog = Join-Path $sessionRoot 'interactions.jsonl'
    if (Test-Path -LiteralPath $interactionLog) {
        foreach ($line in Get-Content -Encoding UTF8 -LiteralPath $interactionLog) {
            try {
                $entry = $line | ConvertFrom-Json
                if ([DateTime]::Parse($entry.time).ToUniversalTime() -ge $startedUtc -and ($entry.passive -ne $true -or $entry.action -notin @('Snapshot', 'Capture', 'Status'))) { $interventions += $entry }
            } catch { $interventions += [pscustomobject]@{ error = 'An interaction log entry could not be validated.' } }
        }
    }
    $criteria = [ordered]@{
        completedRequestedDuration = $clock.Elapsed.TotalMinutes -ge $DurationMinutes -and $clock.Elapsed.TotalMinutes -ge 35
        sameProcessAndCategoryThroughout = $samples.Count -ge 2 -and @($samples | Where-Object { -not $_.valid }).Count -eq 0
        finalFooterAdvancedAtLeast30Minutes = $null -ne $footerAdvanceSeconds -and $footerAdvanceSeconds -ge 1800
        noDiscoveryFailureObserved = @($samples | Where-Object { $_.discoveryFailureLabels.Count -gt 0 }).Count -eq 0
        noHelperInterventionObserved = $interventions.Count -eq 0
        noUnhandledObserverFailure = $null -eq $failure
    }
    $passed = @($criteria.Values | Where-Object { $_ -ne $true }).Count -eq 0
    $summary = [ordered]@{
        passed = $passed; startedAtUtc = $startedUtc.ToString('o'); endedAtUtc = $endedUtc.ToString('o'); elapsedSeconds = $clock.Elapsed.TotalSeconds
        sampleCount = $samples.Count; session = $Session; pid = $observedProcessId; expectedSortingLabel = $ExpectedSortingLabel
        initialSortingValue = $initialSortingValue; finalSortingValue = $(if ($last) { $last.sortingValue } else { $null })
        initialFooter = $(if ($samples.Count) { $samples[0].footerLabels } else { @() }); finalFooter = $(if ($last) { $last.footerLabels } else { @() })
        footerAdvanceSeconds = $footerAdvanceSeconds; criteria = $criteria; failure = $failure; helperInterventions = $interventions
        sampleFilesPattern = 'sample-*.json'; evidenceDirectory = $outputRoot; passive = $true; keepAwakeRequested = $awakeRequested; keepAwakeReleased = $awakeReleased
    }
    Write-NewJson -Path (Join-Path $outputRoot 'summary.json') -Value $summary
    $summary | ConvertTo-Json -Depth 8 | Write-Output
}
if (-not $passed) { exit 1 }
