# Observe the expected system-default player while clicking the app's own button.
param([string]$Session = 'normal-shell')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidenceRoot = Join-Path $taskRoot ('.work\v03-evidence\' + $Session)
$stopFile = Join-Path $evidenceRoot 'opener-observer.stop'
$stateFile = Join-Path $evidenceRoot 'open-media-observation.json'
if (Test-Path -LiteralPath $stopFile) { throw 'This observation already finished.' }
$job = Start-Job -ArgumentList $stopFile -ScriptBlock {
    param($signal)
    $seen = @{}
    while (-not (Test-Path -LiteralPath $signal)) {
        Get-Process -Name Xmp -ErrorAction SilentlyContinue | ForEach-Object {
            if (-not $seen.ContainsKey($_.Id)) {
                $seen[$_.Id] = $true
                [ordered]@{ pid=$_.Id; processName=$_.ProcessName; windowTitle=$_.MainWindowTitle; observedAt=(Get-Date).ToUniversalTime().ToString('o') }
            }
        }
        Start-Sleep -Milliseconds 50
    }
}
try {
    # Ensure the observer started before invoking the UI control.
    Start-Sleep -Seconds 1
    $openLabel = -join @([char]0x6253, [char]0x5F00, [char]0x6587, [char]0x4EF6)
    & (Join-Path $PSScriptRoot 'normal-ui-verification.ps1') -Session $Session -Action Invoke -Name $openLabel
    $clicked = $true
    Start-Sleep -Seconds 4
    Set-Content -Encoding UTF8 -LiteralPath $stopFile -Value 'finished'
    $null = Wait-Job -Job $job -Timeout 5
    $processes = @(Receive-Job -Job $job)
    $result = [ordered]@{ checkedAt=(Get-Date).ToUniversalTime().ToString('o'); clicked=$clicked; session=$Session; playerProcessStarts=$processes }
    $result | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath $stateFile
    $result | ConvertTo-Json -Depth 5
} finally {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
}
