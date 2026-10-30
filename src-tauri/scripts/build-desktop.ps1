param(
    [ValidateSet('test', 'check', 'build', 'bundle')]
    [string]$Action = 'build'
)

$ErrorActionPreference = 'Stop'
$repository = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

function Assert-DesktopVersionConsistency {
    param([string]$PackageJsonText, [string]$TauriJsonText, [string]$CargoTomlText)
    try {
        $packageVersion = (ConvertFrom-Json -InputObject $PackageJsonText).version
        $tauriVersion = (ConvertFrom-Json -InputObject $TauriJsonText).version
    } catch {
        throw "Unable to read application versions from package.json or src-tauri/tauri.conf.json: $($_.Exception.Message)"
    }
    $cargoPackage = [regex]::Matches($CargoTomlText, '(?ms)^[ \t]*\[package\][ \t]*(?:#[^\r\n]*)?\r?\n(?<body>.*?)(?=^[ \t]*\[|\z)')
    if ($cargoPackage.Count -ne 1) { throw 'Unable to find one [package] section in src-tauri/Cargo.toml.' }
    $cargoVersions = [regex]::Matches($cargoPackage[0].Groups['body'].Value, '(?m)^[ \t]*version[ \t]*=[ \t]*(?:"(?<version>[^"\r\n]+)"|''(?<version>[^''\r\n]+)'')[ \t]*(?:#[^\r\n]*)?\r?$')
    if ($cargoVersions.Count -ne 1) { throw 'Unable to read one literal [package] version from src-tauri/Cargo.toml.' }
    $cargoVersion = $cargoVersions[0].Groups['version'].Value
    foreach ($value in @($packageVersion, $tauriVersion, $cargoVersion)) {
        if ($value -isnot [string] -or $value -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
            throw 'Application versions must be explicit semantic-version strings in package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml [package].'
        }
    }
    if ($packageVersion -cne $tauriVersion -or $packageVersion -cne $cargoVersion) {
        throw "Application version mismatch: package.json=$packageVersion; src-tauri/tauri.conf.json=$tauriVersion; src-tauri/Cargo.toml [package]=$cargoVersion. Align all three versions before desktop compilation."
    }
    return $packageVersion
}

# Validate before loading toolchains or starting any compiler/bundler.
$applicationVersion = Assert-DesktopVersionConsistency `
    -PackageJsonText (Get-Content -LiteralPath (Join-Path $repository 'package.json') -Raw -Encoding UTF8) `
    -TauriJsonText (Get-Content -LiteralPath (Join-Path $repository 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8) `
    -CargoTomlText (Get-Content -LiteralPath (Join-Path $repository 'src-tauri\Cargo.toml') -Raw -Encoding UTF8)
Write-Host "Application version $applicationVersion"

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) {
    throw 'Visual Studio Build Tools is required. Install its MSVC x64 tools and Windows 10/11 SDK components.'
}
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw 'MSVC x64 tools were not found by vswhere.' }
$versionFile = Join-Path $installation 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt'
$toolVersion = (Get-Content -LiteralPath $versionFile -Raw).Trim()
$toolset = Join-Path $installation "VC\Tools\MSVC\$toolVersion"

$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
$sdkIncludeRoot = Join-Path $sdkRoot 'Include'
$sdkVersion = Get-ChildItem -LiteralPath $sdkIncludeRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'um\Windows.h') } |
    Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty Name
if ($sdkVersion) {
    $sdkLibraries = Join-Path $sdkRoot "Lib\$sdkVersion"
} else {
    # Optional workspace-only SDK, extracted from Microsoft's official NuGet packages.
    $sdkRoot = Join-Path $repository '.work\toolchain\sdk-common\c'
    $sdkIncludeRoot = Join-Path $sdkRoot 'Include'
    $sdkLibraries = Join-Path $repository '.work\toolchain\sdk-x64\c'
    $sdkVersion = Get-ChildItem -LiteralPath $sdkIncludeRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty Name
}
if (-not $sdkVersion -or -not (Test-Path -LiteralPath (Join-Path $sdkLibraries 'um\x64\kernel32.lib'))) {
    throw 'Windows SDK x64 libraries are missing. Install the Windows SDK or prepare the workspace SDK described in README.'
}
$sdkInclude = Join-Path $sdkIncludeRoot $sdkVersion
$sdkBin = Join-Path $sdkRoot "bin\$sdkVersion\x64"
if (-not (Test-Path -LiteralPath (Join-Path $sdkBin 'rc.exe'))) { throw 'Windows SDK resource compiler rc.exe is missing.' }
$env:LIB = "$(Join-Path $sdkLibraries 'um\x64');$(Join-Path $sdkLibraries 'ucrt\x64');$(Join-Path $toolset 'lib\x64');$env:LIB"
$includePaths = @('ucrt', 'um', 'shared', 'winrt') | ForEach-Object { Join-Path $sdkInclude $_ }
$env:INCLUDE = ($includePaths + (Join-Path $toolset 'include') + $env:INCLUDE) -join ';'
$env:PATH = "$sdkBin;$(Join-Path $toolset 'bin\Hostx64\x64');$env:PATH"
Write-Host "MSVC $toolVersion / Windows SDK $sdkVersion / $Action"

Push-Location (Join-Path $repository 'src-tauri')
try {
    switch ($Action) {
        'test' { & cargo test --lib --locked }
        'check' { & cargo check --all-targets --locked }
        'build' { & cargo build --release --features custom-protocol --locked }
        'bundle' {
            Push-Location $repository
            try { & npm.cmd run tauri -- build --bundles nsis }
            finally { Pop-Location }
        }
    }
    if ($LASTEXITCODE -ne 0) { throw "Desktop $Action failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}
