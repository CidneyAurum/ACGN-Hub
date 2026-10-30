param(
    [ValidateSet('Start', 'Snapshot', 'Invoke', 'Toggle', 'SetValue', 'Select', 'Expand', 'Scroll', 'Keys', 'Capture', 'Close', 'Status')]
    [string]$Action = 'Snapshot',
    [int]$TargetProcessId = 0,
    [string]$Name = '',
    [string]$Value = '',
    [int]$Index = 0,
    [ValidatePattern('^[a-z0-9-]+$')]
    [string]$Session = 'normal-ui',
    [ValidatePattern('^[a-z0-9-]+$')]
    [string]$ProfileName = '',
    [string]$DataDirectory = '',
    [string]$ExecutablePath = '',
    [switch]$ReuseProfile,
    [switch]$Passive
)

# Production interaction through Windows accessibility only. No remote debugging,
# CDP, browser storage access, injected JavaScript, or protection changes.
$ErrorActionPreference = 'Stop'
if ($Passive -and $Action -notin @('Snapshot', 'Capture', 'Status')) { throw 'Passive observation only supports Snapshot, Capture or Status.' }
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidenceRoot = Join-Path $taskRoot ('.work\v03-evidence\' + $Session)
$statePath = Join-Path $evidenceRoot 'launch.json'
New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AcgnVerificationWindow {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
}
'@

function Record-Interaction {
    param([string]$Result)
    [ordered]@{ time=(Get-Date).ToUniversalTime().ToString('o'); action=$Action; name=$Name; index=$Index; passive=[bool]$Passive; result=$Result } |
        ConvertTo-Json -Compress | Add-Content -Encoding UTF8 -LiteralPath (Join-Path $evidenceRoot 'interactions.jsonl')
}

if ($Action -eq 'Start') {
    if (Test-Path -LiteralPath $statePath) { throw 'This verification already has a launch record; do not repeat automatically.' }
    $exe = Join-Path $taskRoot 'src-tauri\target\release\acgn-hub.exe'
    if ($ExecutablePath) {
        $exe = [IO.Path]::GetFullPath($ExecutablePath)
        if (-not $exe.StartsWith(($taskRoot.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($exe) -ne '.exe' -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) {
            throw 'The verification executable must already exist inside this workspace.'
        }
    }
    $profileLabel = if ($ProfileName) { $ProfileName } else { $Session }
    $profile = Join-Path $taskRoot ('.work\' + $profileLabel + '-profile')
    if ($DataDirectory) {
        if (-not $ReuseProfile -or -not [IO.Path]::IsPathRooted($DataDirectory)) { throw 'An explicit absolute existing data directory requires ReuseProfile.' }
        $profile = [IO.Path]::GetFullPath($DataDirectory)
        if (-not $profile.StartsWith(($taskRoot.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $profile -PathType Container)) {
            throw 'The verification data directory must already exist inside this workspace.'
        }
    }
    if ((Test-Path -LiteralPath $profile) -and -not $ReuseProfile) { throw 'Normal UI profile must be fresh unless ReuseProfile is explicitly set.' }
    if ($ReuseProfile -and -not (Test-Path -LiteralPath $profile)) { throw 'The profile selected for restart verification is missing.' }
    $protection = Get-MpComputerStatus
    if (-not $protection.AntivirusEnabled -or -not $protection.RealTimeProtectionEnabled) { throw 'Defender protection must remain enabled.' }
    $record = [ordered]@{
        startedAt = (Get-Date).ToUniversalTime().ToString('o')
        sha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
        executable = $exe; profile = $profile
        reusedProfile = [bool]$ReuseProfile
        remoteDebugging = $false; cdp = $false; injectedJavaScript = $false
        antivirusEnabled = $protection.AntivirusEnabled
        realTimeProtectionEnabled = $protection.RealTimeProtectionEnabled
    }
    $oldDataDir = $env:ACGN_HUB_DATA_DIR
    $oldWebArgs = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    $oldPipe = $env:WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER
    try {
        $env:ACGN_HUB_DATA_DIR = $profile
        Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
        Remove-Item Env:WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER -ErrorAction SilentlyContinue
        $app = Start-Process -FilePath $exe -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru
        $record.pid = $app.Id
        $record | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $statePath
        Record-Interaction 'started'
        $record | ConvertTo-Json
    } finally {
        $env:ACGN_HUB_DATA_DIR = $oldDataDir
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $oldWebArgs
        $env:WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER = $oldPipe
    }
    exit
}

if (-not $TargetProcessId) { $TargetProcessId = (Get-Content -Encoding UTF8 -Raw -LiteralPath $statePath | ConvertFrom-Json).pid }
$app = Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue
if ($Action -eq 'Status') {
    $launch = Get-Content -Encoding UTF8 -Raw -LiteralPath $statePath | ConvertFrom-Json
    $events = @(Get-WinEvent -FilterHashtable @{ LogName='Microsoft-Windows-Windows Defender/Operational'; Id=1116,1117; StartTime=([datetime]$launch.startedAt).ToLocalTime() } -ErrorAction SilentlyContinue |
        ForEach-Object { $xml = [xml]$_.ToXml(); $fields = @{}; foreach ($item in $xml.Event.EventData.Data) { $fields[$item.Name] = $item.'#text' }; [pscustomobject]@{ eventId=$_.Id; time=$_.TimeCreated.ToUniversalTime().ToString('o'); fields=$fields } })
    $result = [ordered]@{ pid=$TargetProcessId; alive=($null -ne $app); checkedAt=(Get-Date).ToUniversalTime().ToString('o'); events=$events }
    $result | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $evidenceRoot 'status.json')
    $result | ConvertTo-Json -Depth 8
    Record-Interaction ('alive=' + ($null -ne $app) + ';defenderEvents=' + $events.Count)
    exit
}
if (-not $app) { throw "Verification process $TargetProcessId has exited; inspect Status before any further execution." }
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetProcessId)
$windows = @([System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition))
# WebView2 can create an unnamed 18px helper pane that Process.MainWindowHandle
# starts returning after navigation. Always target the actual named app window.
$window = $windows | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window -and $_.Current.Name -eq 'ACGN Hub' } | Select-Object -First 1
if (-not $window) { $window = $windows | Where-Object { $_.Current.Name -eq 'ACGN Hub' } | Select-Object -First 1 }
if (-not $window) { $window = $windows | Select-Object -First 1 }
if (-not $window) { throw 'App window is not available yet.' }
$windowHandle = [IntPtr]$window.Current.NativeWindowHandle
if (-not $Passive) { [AcgnVerificationWindow]::ShowWindow($windowHandle, 9) | Out-Null }

if ($Action -eq 'Close') {
    if ($app.MainWindowTitle -eq 'ACGN Hub' -and $app.CloseMainWindow()) {
        Record-Interaction 'normal main-window close requested'; exit
    } elseif ($window.GetSupportedPatterns().Contains([System.Windows.Automation.WindowPattern]::Pattern)) {
        $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
    } else { $app.CloseMainWindow() | Out-Null }
    Record-Interaction 'close requested'; exit
}
if ($Action -eq 'Capture') {
    $rect = New-Object AcgnVerificationWindow+Rect
    if (-not [AcgnVerificationWindow]::GetWindowRect($windowHandle, [ref]$rect)) { throw 'Cannot locate app window.' }
    $bitmap = New-Object Drawing.Bitmap(($rect.Right-$rect.Left), ($rect.Bottom-$rect.Top))
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $deviceContext = $graphics.GetHdc()
        try {
            if (-not [AcgnVerificationWindow]::PrintWindow($windowHandle, $deviceContext, 2)) { throw 'App window capture failed.' }
        } finally { $graphics.ReleaseHdc($deviceContext) }
        $path = Join-Path $evidenceRoot (($Name -replace '[^a-zA-Z0-9_-]', '') + '.png')
        $bitmap.Save($path, [Drawing.Imaging.ImageFormat]::Png)
        Write-Output $path
        Record-Interaction $path
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
    exit
}

$all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
if ($Action -eq 'Snapshot') {
    $rows = @($all | ForEach-Object {
        $item = $_.Current
        $patterns = @($_.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName -replace 'PatternIdentifiers.Pattern', '' })
        if ($item.Name -or $patterns.Count) {
            $row = [ordered]@{ name=$item.Name; type=$item.ControlType.ProgrammaticName; enabled=$item.IsEnabled; offscreen=$item.IsOffscreen; patterns=$patterns }
            # Read only the public recommendation-sort select. Never read edit,
            # password, token, or other control values into accessibility logs.
            if ($item.ControlType -eq [System.Windows.Automation.ControlType]::ComboBox -and $item.Name -match '\u63a8\u8350\u6392\u5e8f$') {
                $row['value'] = $null
                try { $row['value'] = $_.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { }
            }
            [pscustomobject]$row
        }
    })
    $rows | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $evidenceRoot 'last-accessibility.json')
    $rows | Where-Object { $_.name -and -not $_.offscreen } | ForEach-Object { '{0}: {1}' -f ($_.type -replace 'ControlType\.', ''), $_.name }
    Record-Interaction ('elements=' + $rows.Count)
    exit
}
$requiredPattern = switch ($Action) {
    'Invoke' { [System.Windows.Automation.InvokePattern]::Pattern }
    'Toggle' { [System.Windows.Automation.TogglePattern]::Pattern }
    'SetValue' { [System.Windows.Automation.ValuePattern]::Pattern }
    'Select' { [System.Windows.Automation.SelectionItemPattern]::Pattern }
    'Expand' { [System.Windows.Automation.ExpandCollapsePattern]::Pattern }
    'Scroll' { [System.Windows.Automation.ScrollItemPattern]::Pattern }
}
$matches = @($all | Where-Object { $_.Current.Name -eq $Name -and (
    ($Action -eq 'Keys' -and $_.Current.IsKeyboardFocusable) -or $_.GetSupportedPatterns().Contains($requiredPattern)) })
if ($Index -ge $matches.Count) { throw "Accessible element '$Name' at index $Index is missing ($($matches.Count) matches)." }
$element = $matches[$Index]
if ($element.Current.IsOffscreen -and $element.GetSupportedPatterns().Contains([System.Windows.Automation.ScrollItemPattern]::Pattern)) {
    $element.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView()
}
switch ($Action) {
    'Invoke' { $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
    'Toggle' { $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle() }
    'SetValue' { $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Value) }
    'Select' { $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() }
    'Expand' { $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand() }
    'Scroll' { $element.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView() }
    'Keys' {
        Add-Type -AssemblyName System.Windows.Forms
        [AcgnVerificationWindow]::SetForegroundWindow($windowHandle) | Out-Null
        $element.SetFocus()
        [System.Windows.Forms.SendKeys]::SendWait($Value)
    }
}
Write-Output "$Action succeeded: $Name"
Record-Interaction 'succeeded'
