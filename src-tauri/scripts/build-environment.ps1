function Initialize-AcgnWindowsBuildTools {
    param([Parameter(Mandatory=$true)][string]$Repository)
    $ErrorActionPreference = 'Stop'
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio C++ Build Tools are required for Rust host build scripts.' }
    $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $installation) { throw 'MSVC x64 tools were not found.' }
    $toolVersion = (Get-Content -LiteralPath (Join-Path $installation 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt') -Raw).Trim()
    $toolset = Join-Path $installation "VC\Tools\MSVC\$toolVersion"
    $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
    $sdkIncludeRoot = Join-Path $sdkRoot 'Include'
    $sdkVersion = Get-ChildItem -LiteralPath $sdkIncludeRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'um\Windows.h') } |
        Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty Name
    if ($sdkVersion) { $sdkLibraries = Join-Path $sdkRoot "Lib\$sdkVersion" }
    else {
        $sdkRoot = Join-Path $Repository '.work\toolchain\sdk-common\c'
        $sdkIncludeRoot = Join-Path $sdkRoot 'Include'
        $sdkLibraries = Join-Path $Repository '.work\toolchain\sdk-x64\c'
        $sdkVersion = Get-ChildItem -LiteralPath $sdkIncludeRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty Name
    }
    if (-not $sdkVersion -or -not (Test-Path -LiteralPath (Join-Path $sdkLibraries 'um\x64\kernel32.lib'))) { throw 'Windows SDK x64 libraries are missing.' }
    $sdkInclude = Join-Path $sdkIncludeRoot $sdkVersion
    $sdkBin = Join-Path $sdkRoot "bin\$sdkVersion\x64"
    if (-not (Test-Path -LiteralPath (Join-Path $sdkBin 'rc.exe'))) { throw 'Windows SDK resource compiler rc.exe is missing.' }
    $env:LIB = "$(Join-Path $sdkLibraries 'um\x64');$(Join-Path $sdkLibraries 'ucrt\x64');$(Join-Path $toolset 'lib\x64');$env:LIB"
    $includePaths = @('ucrt', 'um', 'shared', 'winrt') | ForEach-Object { Join-Path $sdkInclude $_ }
    $env:INCLUDE = ($includePaths + (Join-Path $toolset 'include') + $env:INCLUDE) -join ';'
    $env:PATH = "$sdkBin;$(Join-Path $toolset 'bin\Hostx64\x64');$env:PATH"
    [pscustomobject]@{ MsvcVersion=$toolVersion; WindowsSdkVersion=$sdkVersion }
}
