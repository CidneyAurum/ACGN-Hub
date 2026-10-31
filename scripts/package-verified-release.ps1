param(
    [string]$EvidenceName = '',
    [string]$NativeEvidencePath = ''
)

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
$release = Join-Path $taskRoot ("release\v" + $version)
$scanPath = Join-Path $taskRoot ('.work\security-audit\' + $EvidenceName + '.json')
$scanData = Get-Content -Encoding UTF8 -Raw -LiteralPath $scanPath | ConvertFrom-Json
$scans = @($scanData)
$manifestPath = Join-Path $release 'VERSION.json'
$old = if (Test-Path -LiteralPath $manifestPath) { Get-Content -Encoding UTF8 -Raw -LiteralPath $manifestPath | ConvertFrom-Json } else { $null }
if ($old -and ($old.version -ne $version -or $old.product -ne $productName)) { throw 'Existing release manifest has another identity; preserved it.' }

function Get-ReleaseRelativePath([string]$Path) {
    $baseUri = New-Object System.Uri(($release.TrimEnd('\') + '\'))
    $targetUri = New-Object System.Uri([IO.Path]::GetFullPath($Path))
    return [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString())
}
function ConvertFrom-Utf8Base64([string]$Value) {
    return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}
function Assert-ReplaceableFile([string]$Name) {
    $destination = Join-Path $release $Name
    if (Test-Path -LiteralPath $destination) {
        if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) { throw "Release destination is not a file; preserved it: $Name" }
        $previous = @(@($old.artifacts) + @($old.supportFiles) | Where-Object { $_ -and $_.file -eq $Name })
        if ($previous.Count -ne 1 -or (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash -ne $previous[0].sha256) {
            throw "Release destination differs from its previous manifest; preserved it: $Name"
        }
    }
}

$nativeRelativePath = $null
if (-not [string]::IsNullOrWhiteSpace($NativeEvidencePath)) {
    $nativeFullPath = if ([IO.Path]::IsPathRooted($NativeEvidencePath)) {
        [IO.Path]::GetFullPath($NativeEvidencePath)
    } else {
        [IO.Path]::GetFullPath((Join-Path $taskRoot $NativeEvidencePath))
    }
    if (-not $nativeFullPath.StartsWith(($taskRoot.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Native evidence must remain inside the workspace.'
    }
    if (-not (Test-Path -LiteralPath $nativeFullPath)) { throw "Native evidence is missing: $nativeFullPath" }
    $nativeRelativePath = Get-ReleaseRelativePath $nativeFullPath
}

$names = @("ACGN-Hub-$version.exe", "ACGN-Hub-$version-x64-setup.exe")
$expectedPaths = @(
    (Join-Path $taskRoot 'src-tauri\target\release\acgn-hub.exe'),
    (Join-Path $taskRoot ("src-tauri\target\release\bundle\nsis\{0}_{1}_x64-setup.exe" -f $productName, $version))
)
if ($scans.Count -ne $expectedPaths.Count) { throw 'Scan evidence must contain exactly the current executable and installer.' }
$selectedScans = @()
for ($index = 0; $index -lt $expectedPaths.Count; $index++) {
    $expected = [IO.Path]::GetFullPath($expectedPaths[$index])
    $matchingScans = @($scans | Where-Object { $_.path -and [IO.Path]::GetFullPath([string]$_.path) -eq $expected })
    if ($matchingScans.Count -ne 1) { throw "Scan evidence does not identify the current build: $expected" }
    $scan = $matchingScans[0]
    if ($scan.version -ne $version -or $scan.product -ne $productName) { throw 'Scan evidence belongs to another product or version.' }
    if ($scan.scanExitCode -ne 0 -or @($scan.newDetectionEvents).Count -gt 0 -or ($scan.scanOutput -join ' ') -notmatch 'found no threats' -or
        $scan.antivirusEnabled -ne $true -or $scan.realTimeProtectionEnabled -ne $true -or
        $scan.artifactPresentAfterScan -ne $true -or $scan.sha256BeforeScan -ne $scan.sha256) {
        throw 'Static scan evidence did not pass.'
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $expected).Hash -ne $scan.sha256) { throw 'Current build differs from scanned file.' }
    $selectedScans += $scan
}
$notesName = ConvertFrom-Utf8Base64 '5L2/55So6K+05piOLm1k'
$launcherName = 'START-PORTABLE.cmd'
$noticeFiles = @('THIRD_PARTY_NOTICES.md', 'third_party/aria2/COPYING', 'third_party/aria2/AUTHORS', 'third_party/aria2/README.mingw', 'third_party/aria2/LICENSE.OpenSSL')
foreach ($name in $noticeFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot $name) -PathType Leaf)) { throw "Third-party notice source is missing: $name" }
}
$supportNames = @($launcherName, $notesName) + $noticeFiles
foreach ($name in @($names) + $supportNames) { Assert-ReplaceableFile $name }
$checksumPath = Join-Path $release 'SHA256SUMS.txt'
if (Test-Path -LiteralPath $checksumPath) {
    if (-not $old) { throw 'Existing checksums have no release manifest; preserved them.' }
    $previousChecksums = (@(@($old.artifacts) + @($old.supportFiles) | Where-Object { $_ } | ForEach-Object { '{0}  {1}' -f $_.sha256, $_.file }) -join [Environment]::NewLine).TrimEnd()
    if ((Get-Content -Encoding UTF8 -Raw -LiteralPath $checksumPath).TrimEnd() -ne $previousChecksums) { throw 'Existing checksums were modified; preserved them.' }
}

# The script stays ASCII so Windows PowerShell 5.1 parses it without a UTF-8 BOM.
# The generated Chinese guide is explicitly decoded and saved as UTF-8.
$notes = ConvertFrom-Utf8Base64 'IyBBQ0dOIEh1YiBfX1ZFUlNJT05fXwoKV2luZG93cyB4NjQgwrcg5a2j5bqm55Wq5Ymn44CB5ryr55S7L+i9u+Wwj+ivtOaOqOiNkOS4juS4i+i9veeuoeeQhuOAguacrOS6pOS7mOWPquWMheWQq+eoi+W6j+S4juivtOaYju+8jOS4jeWMheWQq+eUqOaIt0RhdGHjgIHlqpLkvZPjgIHotKblj7fmiJZDb29raWXjgIIKCiMjIOWQr+WKqOS4jui1hOaWmeS/neeVmQoK5Y+M5Ye7U1RBUlQtUE9SVEFCTEUuY21k77yM5L2/55So5pys55uu5b2V54us56uLRGF0Ye+8m+mmluasoei/kOihjOWIm+W7uui1hOaWmeW6k+OAgeiuvue9ruWSjOe8k+WtmOOAguebtOaOpeWPjOWHu0FDR04tSHViLV9fVkVSU0lPTl9fLmV4ZeS9v+eUqOezu+e7n+m7mOiupOW6lOeUqOi1hOaWmeebruW9leOAgumcgOimgU1pY3Jvc29mdCBFZGdlIFdlYlZpZXcyIFJ1bnRpbWXjgIIKCuayv+eUqOW3suaciei1hOaWmeaXtu+8jOWFiOmAgOWHuuaXp+WunuS+i+W5tuWkh+S7veWujOaVtERhdGHvvIzlho3nlKjlt7LmoLjlr7nnmoTljYfnuqflhaXlj6PmjIflkJHljp/otYTmlpnnm67lvZXjgILmnKzmnLrljYfnuqfnu6fnu63kvb/nlKjljp9yZWxlYXNlL3YwLjMuMi9EYXRh77yb5pys5L6/5pC65ZCv5Yqo6ISa5pys5L2/55So6Ieq5bex55qERGF0Ye+8jOS4jeiHquWKqOWvvOWFpeaXp+i1hOaWmeOAguS4jeimgeWQjOaXtui/kOihjOS4pOS4quWunuS+i+WGmeWQjOS4gERhdGHvvIzkuI3liKDpmaTml6dEYXRh44CBTGlicmFyeeaIluaXp+eJiOacrOOAguacrOi9rk5TSVPlj6rmnoTlu7rlkozmiavmj4/vvIzmnKrlrp7pmYXlronoo4XjgIIKCiMjIOa8q+eUu+OAgei9u+Wwj+ivtOS4juWto+W6puWPkeeOsAoK5ryr55S75ZKM6L275bCP6K+06aaW6aG15o+Q5L6b55yf5a6e57K+6YCJ44CB5bCB6Z2i5aKZ44CB566A5LuL44CB6K+E5YiG44CB5pS26JeP44CB5o6S5bqP5ZKM5Yqg6L295pu05aSa44CC6LWE5paZ5p2l6IeqQmFuZ3VtaeWFrOW8gEFQSe+8jOayoeaciUFJ5Lq654mp44CB6Jma5p6E5L2c5ZOB5oiW6KGl6YCg6K+E5YiG44CC54Ot6Zeo5oyJ5Lq65rCU77yb6auY5YiG6Iez5bCRNTDkurror4TliIbvvJvigJzov5HkuIDlubTng63pl6jigJ3kvb/nlKjov5HkuIDlubTlj5HllK7ml6XmnJ/liqDkurrmsJTmjpLluo/vvIzkuI3mmK/nq6DoioLmm7TmlrDml7bliLvjgILov5vlhaXkvZzlk4Hlj6/mn6XnnIvotYTmlpnvvIzlho3lr7vmib7lhbfkvZPkuIvovb3otYTmupDjgIIKCuS5puexjeaMieWIhuexuy/mjpLluo8v6aG154us56uL57yT5a2YMzDliIbpkp/vvIzpobXpnaLmr4/liIbpkp/mo4Dmn6XliLDmnJ/vvJvnhKbngrnmgaLlpI3jgIHph43mlrDlj6/op4Hlj4rnvZHnu5zmgaLlpI3ml7bmjInpnIDliLfmlrDvvIzov5HmnJ/liJfooajot6jmnKzlnLDml6XmnJ/mm7TmlrDjgILnvZHnu5zlpLHotKXmmL7npLrlkIzliIbnsbvml6fmlbDmja7lkozljp/mm7TmlrDml7bpl7TvvIzmlK/mjIHmiYvliqjliLfmlrDlkozph43or5XjgILkuKXmoLzov4fmu6TlkI7mr4/pobXlj6/lsJHkuo4yNOmDqO+8m+WIh+aNouWIhuexu+S4jeiuqeaXp+ivt+axguimhuebluaWsOmhteOAggoK5Yqo55S75oyJ5pys5Zyw5bm05pyI6YCJ5oupMS80LzcvMTDmnIjlraPluqbvvIzmlK/mjIHlvoDlraPjgIHlm57liLDmnKzlraPjgIHliqDovb3mm7TlpJrlkozni6znq4vlkajljobvvJvot5/pmo/lvZPliY3lraPluqbml7bot6jlraPoh6rliqjmm7TmlrDvvIzmiYvpgInlvoDlraPkv53mjIHmiYDpgInlraPluqbjgIJCYW5ndW1pL1ZORELlj6rmj5DkvpvkvZzlk4HotYTmlpnvvIzkuI3mj5Dkvpvop4bpopHkuIvovb3jgIIKCiMjIOS4i+i9vea6kOeahOeUqOmAlAoK5Lit5paH5ryr55S75LyY5YWITWFuZ2FCWuOAgeaLt+i0ne+8jOaMieWOn+ermemhteWbvueUn+aIkENCWu+8jOS4jei9rOeggeOAgeS4jeaKiuWbvueJh+aUvuWkp+WGkuWFhemrmOa4heOAguaLt+i0neWFrOW8gOeroOiKguW9k+WJjeWPr+WMv+WQjeiuv+mXru+8jOWunumZheWPl+mZkOaXtuWGjeeZu+W9le+8m+S4jeaYr+aJgOacieeroOiKgumDveS/neivgeWFrOW8gOOAgk1hbmdhRGV45piv5aSa6K+t5Y6f5Zu+5aSH55So77yM5om+5Yiw5Y6f5L2c5LiN6KGo56S66K+l6K+t6KiA5pyJ5Y+v5LiL56ug6IqC77yM5ZCM5Lq65Lmf5LiN6IO95Luj5pu/5Y6f5L2c44CCCgrkuK3mlofovbvlsI/or7TkvJjlhYhMTm92ZWzvvIzmjInliIbljbflj5blvpfmraPmlofnlJ/miJBUWFTvvIxUWFTkuI3lkKvmj5Llm77vvJvlhrfnm67lvZXlj6/og73ovoPmhaLvvIzkuZ/mlK/mjIHnq5nngrnkvZzlk4FJRC/pk77mjqXjgIJJbnRlcm5ldCBBcmNoaXZl5piv5re35ZCI6K+t6KiA44CB5qC85byP44CB54mI5pys55qE5YWs5byA5qGj5qGI5aSH55So77yM6ZyA56Gu6K6k5Y6f5L2c5ZKM5a6e6ZmF5paH5Lu25p2D6ZmQ44CCCgrliqjnlLtSU1Pmj5DkvpvlrZfluZXnu4Tno4HlipsvVG9ycmVudO+8m+WFrOW8gOaKleeov+WSjOaho+ahiOS4uueJueWumueUqOmAlOWkh+eUqO+8jOS4jeaKiueJh+auteOAgeino+ivtOOAgeagt+eJh+W9k+ato+eJh+OAgkdhbGdhbWXnq5nlpJbliIbkuqvpobXmmK/ntKLlvJXvvIzpg6jliIbmo4DntKIv5aSW6ZO+6ZyA6KaB5Y6f56uZ55m75b2V77yb6aG16Z2i6ZO+5o6l5LiN5piv5paH5Lu255u06ZO+44CC5p2l5rqQ55So6YCU5o6S5bqP5LiN5piv5a6e5pe25Zyo57q/5L+d6K+B77yb5Y6f5Zyw5Z2A44CBVG9rZW7lkozlkK/nlKjnirbmgIHkv53nlZnjgIJXZWViQ2VudHJhbOOAgeW/q+eci+S/neaMgeaSpOS4i++8jOW3suS4i+i9veaWh+S7tuS/neeVme+8m0pNQ29taWPnu7TmjIHlj6/pgInmnKzmnLpQeXRob27moaXmjqXjgIIKCua6kOeggeS7k+W6k+S4reeahGRvY3MvcmVzZWFyY2gvc291cmNlLWF1ZGl0LXYwMzUtYm9va3MubWTorrDlvZXmnKzmrKHnnJ/lrp7moLfmnKzlkozotJ/kvovvvIzkuI3og73lsIbnm67lvZXlnKjnur/miJblm7rlrprlk43lupTmtYvor5XlvZPmiJDmiYDmnInkvZzlk4HlnYflj6/kuIvovb3jgIIKCiMjIOS4i+i9veWujOaIkOWQjuaJk+W8gOS4juWRveWQjQoK5pmu6YCa5byV5pOO5Lu75Yqh5a6M5oiQ5ZCO5Y+v55u05o6l4oCc5omT5byA5paH5Lu24oCd77yb5aSa5Liq5Y+v55So5oiQ5ZOB5YWI6YCJ5oup55yf5a6e55m76K6w5paH5Lu277yM5LiN5omn6KGMRVhFL0JBVC/ohJrmnKzjgIJNUDTjgIFNS1bjgIFXZWJN44CBTTRW44CBTU9W44CBQVZJ44CBVFPlj4pDQlovVFhUL0VQVUIvUERG5Lqk57uZ57O757uf6buY6K6k5pKt5pS+5Zmo5oiW6ZiF6K+75Zmo77yb5pyq5YWz6IGU56iL5bqP5pe25pi+56S66ZSZ6K+v44CC5pen5YWs5byA5oqV56i/5pys5ZywTVA05rWP6KeI5Zmo6aKE6KeI5L+d5oyB44CC5pS55ZCN5oiW5omT5byA5pON5L2c5b+Z5pe26Zi75q2i6YeN5aSN5pON5L2c77yM6Lev5b6E5LuN5oyJ5Y6f55Sf5YWB6K645qC555uu5b2V5qC45a6e77yM5LiN6Ieq5Yqo5pCs5Yqo5paH5Lu244CCCgrigJzkuIvovb3lrozmiJDlkI7oh6rliqjlkb3lkI3igJ3pu5jorqTlvIDlkK/vvIzku4Xlr7nlt7LlrozmiJBhcmlhMuWNleaWh+S7tuaMieW3suWFs+iBlOS9nOWTgeOAgeWPr+mdoOmbhuaVsOWSjOWOn+aJqeWxleWQjeeUn+aIkOWQjeensOOAguS4jeeMnOa1i+e/u+ivkeaIluWIhui+qOeOh++8m+S4jeaYjuehruaXtuS/neeVmeWOn+WQjeOAguWPquWcqOWOn+ebruW9leaUueWQje+8jOmHjeWQjeS4jeimhueblu+8m+S4i+i9veS4reW/g+WPr+mihOiniOOAgee8lui+keW5tuehruiupOOAguWkmuaWh+S7tumAkOmhuemAieaLqe+8jHFCaXR0b3JyZW505Zyo6Ieq6Lqr5a6i5oi356uv5pS55ZCN5Lul5L+d55WZ5YGa56eN5YWz57O744CC5Y6f5ZCN5Y+v5pCc57Si77yM5ZG95ZCN5aSx6LSl5LiN5pS55Y+Y5LiL6L295a6M5oiQ54q25oCB44CCCgroh6rliqjmlbTnkIbmmK/ni6znq4vnmoTpooTop4jnoa7orqTnp7vliqjmtYHnqIvjgILor6bmg4XkuI4wLjMuNOWOhuWPsueJqeeQhuWRveWQjeivgeaNruWcqOa6kOeggeS7k+W6k2RvY3MvcmVzZWFyY2gvZG93bmxvYWQtbmFtaW5nLXYwMzQubWTvvIzkuI3miorml6fpqozmlLblvZPmnKzova7lho3mrKHmlLnliqjnlKjmiLfmlofku7bjgIIKCiMjIOi/m+W6puOAgeW8leaTjuS4juiusOW9leS/neaKpAoKSFRUUOOAgU1hZ25ldOOAgVRvcnJlbnTpu5jorqTnlKjlhoXnva5hcmlhMu+8jHFCaXR0b3JyZW505Y+v6YCJ77yb5pu05o2iQlTlvJXmk47lj6rlvbHlk43mlrDku7vliqHjgILkuIvovb3kuK3lv4PljLrliIbnp43lrZDjgIHno4HlipvlhYPmlbDmja7jgIHoioLngrnlj5HnjrDjgIHpmJ/liJfjgIHkvKDovpPlkozmoKHpqozvvIzmmL7npLrnnJ/lrp7pm7bpgJ/luqbjgIHov57mjqUv5YGa56eN5pWw5Y+K6ZSZ6K+v56CB44CC56eN5a2Q5o+P6L+w5LiN5piv6KeG6aKR5oiQ5ZOB77yb6YCf5bqm5Y+X6IqC54K55ZKM572R57uc5b2x5ZON44CCCgrkv53nlZlESFTlvJXlr7zjgIHlvJXmk47ph43lkK/mgaLlpI3jgIHlrZDku7vliqHmjqfliLbjgIHpmZDpgJ/kuI7lubblj5HlkIzmraXjgILlhazlvIDonJzmn5Hnp43lrZDpmZDml7bmo4Dmn6Xljp/oh6rluKZUcmFja2Vy5bm25LyY5YWI5Y+v55So5Zyw5Z2A77yM5Y6f5Zyw5Z2A5YWo6YOo5L+d55WZ77yM56eB5pyJ56eN5a2Q5LiN5o6i5rWL44CCTkRN5LuF5p625p6E5Y+C6ICD77yM5rKh5pyJ5aSN5Yi25YW26aG555uu5rqQ56CB5oiW56iL5bqP44CCCgroi6XmnKzlnLDnlJ/miJDku7vliqHnmoTorrDlvZXmmoLml7bml6Dms5Xkv53lrZjvvIzmnKzmrKHnqpflj6Pku43kv53nlZnlt7LnlJ/miJDmiJDlk4HkuI7ov5vluqbvvIzlhYjngrnigJzph43or5Xkv53lrZjorrDlvZXigJ3miJbigJzlr7zlh7rljp/lp4vorrDlvZXigJ3vvIzlho3lhbPpl63lupTnlKjjgILlvoXkv53lrZjml7bnpoHmraLlpIfku73ph43lu7rmuIXnqbrmnKzmrKHnu5PmnpzjgILlrZjlgqjmu6HkuI7kuIvovb3lpLHotKXliIbliKvmj5DnpLrvvIzkuI3lm6DorrDotKblpLHotKXliKDpmaTlt7LmiJDlip/nlJ/miJDnmoTmlofku7bjgIIKCiMjIOWPr+mAieWFrOW8gOinhumikeW3peWFtwoKQuermeWFrOW8gOaKleeov+aUr+aMgeWujOaVtEJW6ZO+5o6l77yM5YWz6ZSu6K+N5pCc57Si5Y+v6IO95Y+XSFRUUDQxMuaIlumqjOivgemZkOWItuOAguS8mOWFiOWFrOW8gOWPr+ivu+WPlueUu+i0qO+8jOm7mOiupOacgOmrmDEwODBw77yM5pi+56S65a6e6ZmF6YCJ5Lit5YiG6L6o546H77yb5qCH6aKY5YaZNEvkuI3mmK/kuIvovb3or4HmmI7jgILpnIDmnKzmnLpQeXRob27jgIF5dC1kbHDkuI5GRm1wZWfvvJvkuI3or7vlj5bmtY/op4jlmajotKblj7cvQ29va2ll77yM5LiN5aSE55CG5LuY6LS55oiWRFJN5YaF5a6544CCCgojIyDlj5HluIPouqvku73kuI7or4Hmja4KCuacrOasoemdmeaAgeaJq+aPj+ivgeaNru+8ml9fU0NBTl9FVklERU5DRV9fCl9fTkFUSVZFX0VWSURFTkNFX05PVEVfXwoKVkVSU0lPTi5qc29u6K6w5b2V5pys5qyh54mI5pys44CBZXhlL+WuieijheWMhS/ovoXliqnmlofku7ZTSEEyNTbjgIHlj5HnjrDmm7TmlrDlkozmnaXmupDnlKjpgJTojIPlm7TjgILlk4HniYxTVkcvSUNP6Lev5b6E5oyH5rqQ56CB5LuT5bqT5paH5Lu277yM5LiN6IO95o2u5q2k6K6k5Li65Y+R5biD55uu5b2V6ZmE5bim5Zu+5qCH5rqQ44CC56iL5bqP44CBZmF2aWNvbuWSjFdpbmRvd3Plm77moIfkvb/nlKjnu5/kuIDkuabnrb7mmJ/moIfvvIzmsqHmnInop5LoibLlm77jgIIKCuacgOe7iOaehOW7uueahOato+W4uOahjOmdouOAgemHjeWQr+OAgeaVsOaNruS/neeVmeS4juWPkeW4g+aguOWvueW6lOS7peacrOasoemZhOW4puWOn+eUn+ivgeaNruWPiua6kOeggeS7k+W6k2RvY3MvcmVzZWFyY2gvZGlzY292ZXJ5LWFuZC1maXhlcy12MDM1Lm1k5Li65YeG44CC5pyq6ZmE57uT5p6c5pe25LiN5a6j56ew55u45YWz54mp55CG5pON5L2c5bey6YCa6L+H77yb5LiA5qyh6Z2Z5oCB5omr5o+P5LiN5Luj6KGo5YWo6YOo5Yqf6IO944CB5YW25a6D5py65Zmo5oiW6ZW/5pyf6L+Q6KGM44CC5Y6G5Y+y5a6J5YWo5oum5oiq5Y2V54us5L+d55WZ77yM6Ziy5oqk5LiN5YWz6Zet44CB5LiN5Yqg5o6S6Zmk44CCCgogICAgR2V0LUZpbGVIYXNoIC1BbGdvcml0aG0gU0hBMjU2IC1MaXRlcmFsUGF0aCAnLlxBQ0dOLUh1Yi1fX1ZFUlNJT05fXy5leGUnLCAnLlxBQ0dOLUh1Yi1fX1ZFUlNJT05fXy14NjQtc2V0dXAuZXhlJwo='
$scanRelativePath = Get-ReleaseRelativePath $scanPath
$nativeNote = if ($nativeRelativePath) {
    (ConvertFrom-Utf8Base64 '5pys5qyh5Y6f55Sf5qGM6Z2i6aqM5pS26K+B5o2u77ya' ) + $nativeRelativePath
} else {
    ConvertFrom-Utf8Base64 '5pys5qyh5omT5YyF5rKh5pyJ6ZmE5Y6f55Sf5ryr55S76L+Q6KGM6K+B5o2u77yb6Z2Z5oCB5omr5o+P5LiN5Luj6KGo5LiL6L295rWB56iL5bey57uP6aqM5pS244CC'
}
$notes = $notes.Replace('__VERSION__', $version).Replace('__SCAN_EVIDENCE__', $scanRelativePath).Replace('__NATIVE_EVIDENCE_NOTE__', $nativeNote)
$versionGuide = Join-Path $taskRoot ("docs\releases\v{0}-usage.md" -f $version)
if (Test-Path -LiteralPath $versionGuide -PathType Leaf) {
    $notes = [IO.File]::ReadAllText($versionGuide, [Text.Encoding]::UTF8)
}
$launcher = @(
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    'set "ACGN_HUB_DATA_DIR=%~dp0Data"',
    ('start "" "%~dp0' + $names[0] + '"'),
    'endlocal'
) -join "`r`n"
$launcher += "`r`n"

New-Item -ItemType Directory -Force -Path $release | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
$artifacts = @()
for ($index = 0; $index -lt $names.Count; $index++) {
    $scan = $selectedScans[$index]
    $destination = Join-Path $release $names[$index]
    # An unchanged published executable may already be running. Reuse exactly
    # matching bytes instead of trying to overwrite the mapped Windows image.
    $alreadyMatches = (Test-Path -LiteralPath $destination -PathType Leaf) -and ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -eq $scan.sha256)
    if (-not $alreadyMatches) { Copy-Item -LiteralPath $scan.path -Destination $destination -Force }
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $scan.sha256) { throw 'Copied artifact hash mismatch.' }
    $artifacts += [ordered]@{ file = $names[$index]; sizeBytes = (Get-Item -LiteralPath $destination).Length; sha256 = $scan.sha256 }
}
[IO.File]::WriteAllText((Join-Path $release $launcherName), $launcher, [Text.Encoding]::ASCII)
[IO.File]::WriteAllText((Join-Path $release $notesName), $notes, $utf8)
foreach ($name in $noticeFiles) {
    $destination = Join-Path $release $name
    New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($destination)) | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskRoot $name) -Destination $destination -Force
}
$supportFiles = @()
foreach ($name in $supportNames) {
    $path = Join-Path $release $name
    $supportFiles += [ordered]@{ file = $name; sizeBytes = (Get-Item -LiteralPath $path).Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash }
}
$manifest = [ordered]@{
    product = $productName
    version = $version
    platform = 'Windows x64'
    releaseScope = if ($version -eq '0.3.7') { 'v037 live VNDB Galgame discovery, official release/trial sources, curated verified game entries, KUN alias and pagination fixes; v036 local viewing and unified author search retained' } elseif ($version -eq '0.3.6') { 'v036 in-app comic/novel/video viewing, continuous/fullscreen reading, per-work continuation, manga edition selection and official Bangumi author search' } else { 'v035 real book discovery, unified bookmark-star branding, source curation and workflow fixes; naming and BT reliability retained' }
    sourceRepository = 'https://github.com/CidneyAurum/ACGN-Hub'
    thirdPartyNotices = $noticeFiles
    bookDiscovery = [ordered]@{
        source = 'Bangumi public v0 subject search; verified platform and light-novel category signals'
        refreshTtlMinutes = 30
        refreshTriggers = @('minute expiry check', 'window focus', 'visible document', 'network restored', 'local-date change for recent releases')
        sorts = @('heat', 'score with at least 50 votes', 'past-year release window ordered by heat')
        pageSize = 24
        apiRequestCap = 20
        cacheScope = 'media type, sort and page; fallback retains original updatedAt'
        classification = 'explicit platform first; reject ambiguous, NSFW, incomplete or isolated joke-tag results'
        fabricatedRatings = $false
    }
    brandIcon = [ordered]@{
        design = 'bookmark and star; no character artwork or AI-generated image'
        repositorySvgPath = 'src-tauri/icons/icon.svg'
        svgSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $taskRoot 'src-tauri\icons\icon.svg')).Hash
        repositoryIcoPath = 'src-tauri/icons/icon.ico'
        icoSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $taskRoot 'src-tauri\icons\icon.ico')).Hash
        assetPathScope = 'source repository paths; no separate SVG source payload promised in portable release'
    }
    sourcesCuration = [ordered]@{
        animePrimary = @('Mikan RSS', 'AcgnX RSS', 'configured anime RSS')
        chineseMangaPrimary = @('MangaBZ', 'CopyManga')
        chineseNovelPrimary = @('LNovel TXT; illustrations excluded')
        backup = @('MangaDex multilingual original pages', 'public video submissions', 'Internet Archive public files')
        galgame = if ($version -eq '0.3.7') { 'KUN paginated community index; VNDB official release and trial entries; curated official demo/free store links and Stage-nana Japanese freeware archive' } else { 'external resource index; share page is not a direct file' }
        rankingMeaning = 'adapter purpose preference; not a live availability or full-download guarantee'
        userConfigurationHandling = 'preserve existing addresses, tokens and enabled states'
        bookAuditRepositoryPath = 'docs/research/source-audit-v035-books.md'
    }
    completedOutputOpening = [ordered]@{
        scope = 'completed registered video or book files; explicit selection for multiple outputs'
        extensions = @('mp4', 'mkv', 'webm', 'm4v', 'mov', 'avi', 'ts', 'cbz', 'txt', 'epub', 'pdf')
        engineDownloadsPreferSystem = $true
        legacyLocalMp4PreviewRetained = $true
        pathHandling = 'native canonical checks within task or explicitly configured roots; no arbitrary parent allowance'
    }
    inAppViewer = [ordered]@{
        available = (@('0.3.6', '0.3.7') -contains $version)
        comics = 'read-only CBZ pages; default continuous scroll or single-page mode, bounded nearby images, natural filename order, page jump, arrow keys, fullscreen toolbar/navigation and saved position'
        novels = 'UTF-8 TXT with optional BOM; plain-text chapter navigation, font size, line height, paper themes, reading width and saved scroll position'
        video = 'WebView2 media controls; bounded Range reads and saved playback position; codecs depend on the system'
        fallback = 'system default application remains available; EPUB/PDF are external only'
        access = 'current completed task output only; opaque in-memory sessions revoked when leaving; no archive extraction'
        limits = '1000 comic pages, 50 MiB/page, 500 MiB uncompressed chapter, 20 MiB TXT, 8 MiB video chunk'
        userMediaBundled = $false
        continuation = 'only completed, allowlisted outputs of the same known work/edition; cancellable automatic next chapter/volume; no new downloads'
    }
    authorSearch = 'unified query matches subject titles and reliable person names/aliases; official person-subject relationships appear directly as works, with no person-card prerequisite'
    mangaEditions = 'same-title source works remain separate by source ID, authors and chapter metadata; new chapter output directories include the edition identity'
    localOutputPersistence = 'retain published output and pending in-memory history on storage failure; retry/export before close; no rebuild while pending'
    completedDownloadNaming = [ordered]@{
        enabledByDefault = $true
        automaticScope = 'completed aria2 single-file tasks with reliable saved identity'
        manualScope = 'registered task files, individually previewed and confirmed'
        directoryHandling = 'rename in the original directory; no archive move'
        extensionHandling = 'preserve original extension'
        conflictHandling = 'never overwrite an existing destination'
        history = 'original name and path retained; searchable with current name'
        failureHandling = 'naming errors do not change completed download state'
        qBittorrent = 'rename in its own client to preserve seeding path association'
        physicalVerification = 'only as recorded in attached native evidence'
    }
    ndmIntegration = 'reference only; no project source or binaries copied'
    btImprovements = @('no zero-speed auto-stop', 'managed engine restart recovery', 'DHT bootstrap and isolated cache', 'live limits and concurrency', 'child-task controls', 'persisted transfer diagnostics', 'source-owned Mikan tracker preflight')
    packagedAt = (Get-Date).ToUniversalTime().ToString('o')
    builtAt = (Get-Item -LiteralPath $selectedScans[0].path).LastWriteTime.ToUniversalTime().ToString('o')
    portableExecutable = $names[0]
    installer = $names[1]
    portableLauncher = $launcherName
    portableDataDirectory = 'Data'
    usageGuide = $notesName
    artifacts = $artifacts
    supportFiles = $supportFiles
    installerActuallyInstalled = $false
    bundledUserData = $false
    bundledUserMedia = $false
    staticScanEvidence = $scanRelativePath
    securityHistory = '../../docs/research/security-interception.md'
    seasonDiscovery = [ordered]@{
        source = 'Bangumi public subject search'
        calendarBasis = 'local year and month; quarters start in January, April, July and October'
        premiereDateWindow = 'quarter start inclusive; next-quarter start exclusive'
        sort = 'heat'
        pageSize = 24
        historicalSeasonSelection = $true
        loadMore = $true
        cacheTtlMinutes = 30
        cacheScope = 'year, quarter and page; same-season fallback with original timestamp'
    }
    newMangaSources = @(
        [ordered]@{ name = 'MangaBZ'; languages = @('zh-Hans', 'zh-Hant'); enabledByDefault = $false }
    )
    removedMangaSources = @('WeebCentral', 'Kuaikan')
    removedSourceDataHandling = 'source entries and configuration removed; downloaded files and other user data preserved'
    mangaImageHandling = 'original source bytes; no image transcoding or recompression; byte-signature validation'
    nativeEvidenceAttached = [bool]$nativeRelativePath
}
if ($nativeRelativePath) {
    if ($version -eq '0.3.7') { $manifest['galgameNativeEvidence'] = $nativeRelativePath }
    else { $manifest['mangaNativeEvidence'] = $nativeRelativePath }
}
[IO.File]::WriteAllText($manifestPath, (ConvertTo-Json -InputObject $manifest -Depth 7), $utf8)
$checksumText = (@(@($artifacts) + @($supportFiles) | ForEach-Object { '{0}  {1}' -f $_.sha256, $_.file }) -join [Environment]::NewLine) + [Environment]::NewLine
[IO.File]::WriteAllText($checksumPath, $checksumText, $utf8)
$artifacts | ConvertTo-Json

