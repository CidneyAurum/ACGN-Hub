param(
    [ValidateSet('init','build','info')][string]$Action = 'build',
    [ValidateSet('aarch64','armv7','i686','x86_64')][string[]]$Targets = @('aarch64','x86_64'),
    [string]$SdkRoot = '',
    [switch]$Debug,
    [switch]$UseCliSymlinks,
    [switch]$PackageOnly
)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (-not $SdkRoot) { $SdkRoot = $env:ANDROID_HOME }
if (-not $SdkRoot) { $SdkRoot = $env:ANDROID_SDK_ROOT }
if (-not $SdkRoot -and (Test-Path -LiteralPath 'D:\Android\android-sdk')) { $SdkRoot = 'D:\Android\android-sdk' }
if (-not $SdkRoot -or -not (Test-Path -LiteralPath (Join-Path $SdkRoot 'platform-tools\adb.exe'))) { throw 'Set ANDROID_HOME to an installed Android SDK.' }
$ndkRoot = $env:NDK_HOME
if (-not $ndkRoot) {
    $ndkRoot = Get-ChildItem -LiteralPath (Join-Path $SdkRoot 'ndk') -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'toolchains\llvm\prebuilt\windows-x86_64\bin\clang.exe') } |
        Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $ndkRoot) { throw 'Android NDK is missing. Install a side-by-side NDK with SDK Manager.' }
if (-not $env:JAVA_HOME -or -not (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\java.exe'))) { throw 'JAVA_HOME must point to JDK 17 or another JDK supported by the Gradle wrapper.' }
$env:ANDROID_HOME = [IO.Path]::GetFullPath($SdkRoot)
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:NDK_HOME = [IO.Path]::GetFullPath($ndkRoot)
$env:ANDROID_NDK_HOME = $env:NDK_HOME
if (-not $env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS = '1' }
if ($env:NODE_OPTIONS -notmatch '--max-old-space-size') { $env:NODE_OPTIONS = ($env:NODE_OPTIONS + ' --max-old-space-size=1024').Trim() }
$env:GRADLE_OPTS = ($env:GRADLE_OPTS + ' -Dorg.gradle.workers.max=1').Trim()
. (Join-Path $PSScriptRoot 'build-environment.ps1')
$hostTools = Initialize-AcgnWindowsBuildTools -Repository $repository
Write-Host "Android SDK $SdkRoot / NDK $ndkRoot / Java $env:JAVA_HOME / MSVC $($hostTools.MsvcVersion)"
Push-Location $repository
try {
    if ($Action -eq 'info') { return }
    if ($Action -eq 'init') { & npm.cmd run tauri -- android init --ci --skip-targets-install }
    elseif ($UseCliSymlinks) {
        $arguments = @('run','tauri','--','android','build','--apk','--target') + $Targets + @('--ci')
        if ($Debug) { $arguments += '--debug' }
        & npm.cmd @arguments
    } else {
        # Tauri's Windows CLI links each built .so into jniLibs. Copy verified
        # native outputs instead, so packaging does not require Developer Mode
        # or a global symbolic-link privilege change.
        $targetMap = @{
            aarch64 = @{ Triple='aarch64-linux-android'; Abi='arm64-v8a'; Arch='arm64'; Task='Arm64' }
            armv7 = @{ Triple='armv7-linux-androideabi'; Abi='armeabi-v7a'; Arch='arm'; Task='Arm' }
            i686 = @{ Triple='i686-linux-android'; Abi='x86'; Arch='x86'; Task='X86' }
            x86_64 = @{ Triple='x86_64-linux-android'; Abi='x86_64'; Arch='x86_64'; Task='X86_64' }
        }
        $buildProfile = if ($Debug) { 'debug' } else { 'release' }
        $profileTask = if ($Debug) { 'Debug' } else { 'Release' }
        $project = Join-Path $repository 'src-tauri\gen\android'
        $logRoot = Join-Path $repository '.work\android-build'
        New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
        $native = @()
        if (-not $PackageOnly) {
        foreach ($target in $Targets) {
            $details = $targetMap[$target]
            $log = Join-Path $logRoot ("native-$target-$buildProfile.log")
            Write-Host "Compiling Android native library: $target (log: $log)"
            $arguments = @('run','tauri','--','android','build','--apk','--target',$target,'--ci')
            if ($Debug) { $arguments += '--debug' }
            $previousPreference = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            & npm.cmd @arguments *> $log
            $nativeExit = $LASTEXITCODE
            $ErrorActionPreference = $previousPreference
            $nativeLog = [IO.File]::ReadAllText($log)
            if ($nativeExit -ne 0 -and ($nativeLog -notmatch 'Failed to create a symbolic link' -or $nativeLog -notmatch 'Creation symbolic link is not allowed')) {
                Get-Content -LiteralPath $log -Tail 50 | Write-Host
                throw "Android native compilation failed for $target (exit $nativeExit)."
            }
            $source = Join-Path $repository ("src-tauri\target\{0}\{1}\libacgn_hub_lib.so" -f $details.Triple, $buildProfile)
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Android native output is missing: $source" }
            $destinationRoot = Join-Path $project ("app\src\main\jniLibs\" + $details.Abi)
            New-Item -ItemType Directory -Force -Path $destinationRoot | Out-Null
            $destination = Join-Path $destinationRoot 'libacgn_hub_lib.so'
            if (Test-Path -LiteralPath $destination) {
                $existing = Get-Item -LiteralPath $destination
                if ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Remove only the known generated JNI symlink before using copy-based packaging.' }
            }
            Copy-Item -LiteralPath $source -Destination $destination -Force
            $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
            if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $sourceHash) { throw 'Copied Android native library hash mismatch.' }
            $native += [ordered]@{ target=$target; triple=$details.Triple; abi=$details.Abi; sha256=$sourceHash; cliLinkPermissionUnavailable=($nativeExit -ne 0) }
        }
        ConvertTo-Json -InputObject @($native) | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $logRoot 'native-libraries.json')
        } else {
            $native = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $logRoot 'native-libraries.json') | ConvertFrom-Json
            foreach ($target in $Targets) {
                $record = @($native | Where-Object { $_.target -eq $target })
                $destination = Join-Path $project ("app\src\main\jniLibs\" + $targetMap[$target].Abi + '\libacgn_hub_lib.so')
                if ($record.Count -ne 1 -or -not (Test-Path -LiteralPath $destination -PathType Leaf) -or (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $record[0].sha256) { throw 'PackageOnly requires the previously verified JNI library copies.' }
            }
            Write-Host 'Packaging previously compiled and verified native libraries; source changes require a full build.'
        }
        $abiList = ($Targets | ForEach-Object { $targetMap[$_].Abi }) -join ','
        $archList = ($Targets | ForEach-Object { $targetMap[$_].Arch }) -join ','
        $targetList = $Targets -join ','
        $gradleArguments = @('--project-dir',$project,"assembleUniversal$profileTask",'--no-daemon','--console=plain',"-PabiList=$abiList","-ParchList=$archList","-PtargetList=$targetList")
        foreach ($target in $Targets) { $gradleArguments += @('-x',("rustBuild" + $targetMap[$target].Task + $profileTask)) }
        & (Join-Path $project 'gradlew.bat') @gradleArguments
    }
    if ($LASTEXITCODE -ne 0) { throw "Android $Action failed with exit code $LASTEXITCODE." }
} finally { Pop-Location }
