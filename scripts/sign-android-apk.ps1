param(
    [Parameter(Mandatory=$true)][string]$InputApk,
    [Parameter(Mandatory=$true)][string]$OutputApk,
    [string]$SdkRoot = '',
    [string]$SigningDirectory = ''
)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $SdkRoot) { $SdkRoot = $env:ANDROID_HOME }
if (-not $SdkRoot) { throw 'Set ANDROID_HOME to the installed Android SDK.' }
if (-not $SigningDirectory) { $SigningDirectory = Join-Path $repository '.local\android-signing' }
$InputApk = [IO.Path]::GetFullPath($InputApk)
$OutputApk = [IO.Path]::GetFullPath($OutputApk)
if (-not (Test-Path -LiteralPath $InputApk -PathType Leaf)) { throw 'Unsigned APK is missing.' }
if (Test-Path -LiteralPath $OutputApk) { throw 'Signed APK already exists; preserve it before creating another delivery.' }
$buildTools = Get-ChildItem -LiteralPath (Join-Path $SdkRoot 'build-tools') -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'apksigner.bat') } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $buildTools) { throw 'Android build-tools with apksigner and zipalign are required.' }
if (-not $env:JAVA_HOME) { throw 'JAVA_HOME is required for APK signing.' }
$keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
$key = Join-Path $SigningDirectory 'acgn-hub-release.p12'
$passwordFile = Join-Path $SigningDirectory 'keystore-password.txt'
if (-not (Test-Path -LiteralPath $SigningDirectory)) {
    New-Item -ItemType Directory -Path $SigningDirectory -Force | Out-Null
    $account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $SigningDirectory '/inheritance:r' '/grant:r' "${account}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the new private signing directory.' }
}
if (-not (Test-Path -LiteralPath $key)) {
    if (Test-Path -LiteralPath $passwordFile) { throw 'A previous signing password exists without its key; preserve and inspect that material first.' }
    $bytes = New-Object byte[] 32
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    [IO.File]::WriteAllText($passwordFile, [Convert]::ToBase64String($bytes), [Text.Encoding]::ASCII)
    & $keytool '-genkeypair' '-keystore' $key '-storetype' 'PKCS12' '-storepass:file' $passwordFile '-keypass:file' $passwordFile '-alias' 'acgn-hub' '-keyalg' 'RSA' '-keysize' '3072' '-validity' '10000' '-dname' 'CN=ACGN Hub, O=ACGN Hub, C=CN'
    if ($LASTEXITCODE -ne 0) { throw 'Application signing key generation failed.' }
}
if (-not (Test-Path -LiteralPath $passwordFile -PathType Leaf)) { throw 'The local application signing password is missing.' }
$aligned = Join-Path $SigningDirectory ('aligned-' + [guid]::NewGuid().ToString('N') + '.apk')
& (Join-Path $buildTools.FullName 'zipalign.exe') '-P' '16' '-f' '4' $InputApk $aligned
if ($LASTEXITCODE -ne 0) { throw 'APK alignment failed.' }
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($OutputApk)) | Out-Null
# PKCS12 uses the store password for the private key too. apksigner reads each
# file: occurrence as a successive line, so passing one single-line file twice
# incorrectly exhausts it. Omitting --key-pass uses the same store password.
& (Join-Path $buildTools.FullName 'apksigner.bat') 'sign' '--ks' $key '--ks-key-alias' 'acgn-hub' '--ks-pass' "file:$passwordFile" '--v2-signing-enabled' 'true' '--v3-signing-enabled' 'true' '--v4-signing-enabled' 'false' '--out' $OutputApk $aligned
if ($LASTEXITCODE -ne 0) { throw 'APK signing failed.' }
& (Join-Path $buildTools.FullName 'apksigner.bat') 'verify' '--verbose' '--print-certs' $OutputApk
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
& (Join-Path $buildTools.FullName 'zipalign.exe') '-c' '-P' '16' '4' $OutputApk
if ($LASTEXITCODE -ne 0) { throw 'Signed APK alignment verification failed.' }
Write-Output "Signed APK: $OutputApk"
Write-Output 'Keep the local signing directory private and backed up for future updates.'
