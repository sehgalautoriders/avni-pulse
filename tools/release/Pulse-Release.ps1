# RELEASE CONTROL: the release steps of AVNI Pulse (target AVNI-PULSE, chain avni-pulse), our own live audience interaction.
# The "product" is the public web app on GitHub Pages: https://sehgalautoriders.github.io/avni-pulse/ (repository
# sehgalautoriders/avni-pulse, served from the docs\ folder of main). Installing = pushing the candidate commit to main and asking
# GitHub for a Pages build; the live check = the site serves the candidate's build string and the database answers.
# Run ONLY by Sentinel's tools\avni_release.py release / execute (a ticket is checked first). Written 24-10-2026 (lease CLAU-1912).
#
# Phases:
#   build    - the staged candidate's docs\ is copied to {build}\site; config.js, index.html and host.html must carry ONE build
#              string (PULSE_BUILD); the stamp PULSE-RELEASE.json names release, commit and build.
#   test     - every page file is there; every script parses (node --check); our QR maker is read back by two QR readers
#              (tests\qr_check.py, Python 3.12); the database side passes tests\rpc_smoke.mjs (disposable TEST event, ended
#              after); never backwards: the candidate contains the commit GitHub serves now.
#   snapshot - the commit GitHub serves now is kept in {rc_root}\Rollback\{rc}\live-before.json (a push back = the rollback).
#   install  - git push <github> <candidate>:main; a Pages build is asked for; the installed stamp is written for the pipe.
#   verify   - GitHub reports the build of the candidate 'built' and the site serves the candidate's build string.
#   rollback - git push --force <github> <live-before>:main, stamp restored.
param(
    [Parameter(Mandatory)][ValidateSet('build', 'test', 'snapshot', 'install', 'verify', 'rollback')][string]$Phase,
    [Parameter(Mandatory)][string]$Rc,
    [Parameter(Mandatory)][string]$Staging,
    [Parameter(Mandatory)][string]$Build,
    [Parameter(Mandatory)][string]$Commit,
    [Parameter(Mandatory)][string]$RcRoot,
    [string]$Remote = 'https://github.com/sehgalautoriders/avni-pulse.git',
    [string]$GhRepo = 'sehgalautoriders/avni-pulse',
    [string]$Site = 'https://sehgalautoriders.github.io/avni-pulse'
)
if (Test-Path -LiteralPath 'C:\02 - OUR FILES\Access to all drives\AVNI\00 - CONTROL\RELEASE-FREEZE.json') { [Console]::Error.WriteLine("RELEASE FREEZE - refused: Ravi froze every version change (AVNI\00 - CONTROL\RELEASE-FREEZE.json). Nothing was changed."); exit 4 }
$ErrorActionPreference = 'Stop'
$sentinelTools = 'C:\02 - OUR FILES\Access to all drives\AVNI\90 - WORKTREES\Active\WP-0038 - AVNI SENTINEL\tools'
& python (Join-Path $sentinelTools 'avni_release.py') check-ticket | Out-Null
if ($LASTEXITCODE -ne 0) { throw "RELEASE CONTROL: no valid release ticket - this script is run by AVNI Sentinel's release executor only." }
try { [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal' } catch { }

$src     = Join-Path $Staging 'avni-pulse'          # the pipe's detached checkout of the candidate
$siteDir = Join-Path $Build 'site'
$stamp   = 'PULSE-RELEASE.json'
$rollDir = Join-Path $RcRoot "Rollback\$Rc"
$before  = Join-Path $rollDir 'live-before.json'
$instDir = Join-Path $RcRoot 'Installed'
$instF   = Join-Path $instDir 'AVNI-PULSE.json'
$wall    = Join-Path $sentinelTools 'avni_internet.py'
$py312   = 'C:\Users\sehga\AppData\Local\Programs\Python\Python312\python.exe'

function BuildOf([string]$file, [string]$pattern) {
    $t = Get-Content -LiteralPath $file -Raw
    $m = [regex]::Match($t, $pattern)
    if (-not $m.Success) { throw "no build string in $file" }
    return $m.Groups[1].Value
}
function SiteBuild([string]$dir) {
    $b = BuildOf (Join-Path $dir 'js\config.js') "PULSE_BUILD = '([^']+)'"
    foreach ($f in 'index.html', 'host.html') {
        $o = BuildOf (Join-Path $dir $f) '<meta name="pulse-build" content="([^"]+)"'
        if ($o -ne $b) { throw "build strings differ: js\config.js $b, $f $o - change all three together" }
    }
    return $b
}
function Internet([int]$mb) {
    & python $wall --app "Release Control AVNI-PULSE $Rc" --need-mb $mb | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "the internet wall said NO - the release waits; nothing pushed" }
}
function GitRetry([string[]]$a, [int]$tries) {
    $out = ''
    for ($i = 0; $i -lt $tries; $i++) {
        $out = & git @a 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) { return $out }
        Start-Sleep -Seconds 15
    }
    throw "git $($a[0..2] -join ' ') failed after $tries tries: $($out.Trim())"
}
function LiveCommit() {
    Internet 1
    $out = GitRetry @('ls-remote', $Remote, 'refs/heads/main') 4
    $m = [regex]::Match($out, '^([0-9a-f]{40})')
    if (-not $m.Success) { return $null }       # an empty repository: nothing is live yet
    return $m.Groups[1].Value
}
function Fetch([string]$url, [int]$tries) {
    $last = ''
    for ($i = 0; $i -lt $tries; $i++) {
        try {
            $r = Invoke-WebRequest -Uri ($url + '?rc=' + [guid]::NewGuid().ToString('N')) -Headers @{ 'Cache-Control' = 'no-cache'; 'Pragma' = 'no-cache' } -TimeoutSec 20 -UseBasicParsing
            return $r.Content
        } catch { $last = $_.Exception.Message; Start-Sleep -Seconds 10 }
    }
    throw "the site did not answer at $url ($last)"
}

switch ($Phase) {
    'build' {
        $docs = Join-Path $src 'docs'
        if (-not (Test-Path -LiteralPath (Join-Path $docs 'index.html'))) { throw "the staged candidate has no docs\index.html ($docs)" }
        if (Test-Path $siteDir) { Remove-Item $siteDir -Recurse -Force }
        New-Item -ItemType Directory -Force $siteDir | Out-Null
        robocopy $docs $siteDir /E /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
        $b = SiteBuild $siteDir
        [ordered]@{ release = $Rc; commit = $Commit; build = $b; builtAt = (Get-Date -Format 'dd-MM-yyyy HH:mm') } |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Build $stamp) -Encoding UTF8
        Write-Host "built: $((Get-ChildItem $siteDir -File -Recurse).Count) files in $siteDir, build $b, commit $($Commit.Substring(0, 7))"
    }
    'test' {
        foreach ($f in 'index.html', 'host.html', 'css\pulse.css', 'js\config.js', 'js\api.js', 'js\render.js', 'js\join.js', 'js\host.js', 'js\qr.js', 'img\pulse-icon.svg', '.nojekyll') {
            if (-not (Test-Path -LiteralPath (Join-Path $siteDir $f))) { throw "the site misses $f" }
        }
        foreach ($f in Get-ChildItem (Join-Path $siteDir 'js') -Filter *.js) {
            $o = & node --check $f.FullName 2>&1 | Out-String
            if ($LASTEXITCODE -ne 0) { throw "$($f.Name) does not parse: $o" }
        }
        foreach ($f in 'index.html', 'host.html') {
            $t = Get-Content -LiteralPath (Join-Path $siteDir $f) -Raw
            if (-not $t.TrimEnd().EndsWith('</html>')) { throw "$f does not end with </html> - a broken file" }
        }
        Push-Location $src
        try {
            $o = & $py312 'tests\qr_check.py' 2>&1 | Out-String
            if ($LASTEXITCODE -ne 0) { throw "the QR check failed:`n$o" }
            Write-Host "  QR: $(($o -split "`n" | Where-Object { $_ -match 'ALL OK' }) -join '')"
            Internet 1
            $o = & node 'tests\rpc_smoke.mjs' 2>&1 | Out-String
            if ($LASTEXITCODE -ne 0) { throw "the database check failed:`n$o" }
            Write-Host "  database: $(($o -split "`n" | Where-Object { $_ -match 'CHECKS' }) -join '')"
        } finally { Pop-Location }
        $live = LiveCommit
        if ($live) {
            & git -C $src merge-base --is-ancestor $live $Commit 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "GitHub serves $($live.Substring(0, 7)), which the candidate $($Commit.Substring(0, 7)) does not contain - build the job on top of what is live" }
        }
        Write-Host "tests passed: build $(SiteBuild $siteDir), files whole, scripts parse, QR read back, database checks passed, candidate contains the live commit $(if ($live) { $live.Substring(0, 7) } else { '(none yet)' })"
    }
    'snapshot' {
        $live = LiveCommit
        New-Item -ItemType Directory -Force $rollDir | Out-Null
        $lb = ''
        try { $lb = [regex]::Match((Fetch "$Site/js/config.js" 2), "PULSE_BUILD = '([^']+)'").Groups[1].Value } catch {}
        [ordered]@{ release = $Rc; liveCommit = $live; liveBuild = $lb; keptAt = (Get-Date -Format 'dd-MM-yyyy HH:mm') } |
            ConvertTo-Json | Set-Content -LiteralPath $before -Encoding UTF8
        Write-Host "rollback point kept: GitHub serves $(if ($live) { $live.Substring(0, 7) } else { 'nothing yet' }) ($lb)"
    }
    'install' {
        Internet 5
        $out = GitRetry @('-C', $src, 'push', $Remote, "${Commit}:refs/heads/main") 4
        Write-Host ("  " + $out.Trim())
        # a Pages build asked for through the API publishes within a minute (the Hero web app's lesson of 07-10-2026)
        $asked = ''
        for ($i = 0; $i -lt 4; $i++) {
            try { $asked = (& gh api -X POST "repos/$GhRepo/pages/builds" 2>$null | ConvertFrom-Json).status; if ($asked) { break } } catch {}
            Start-Sleep -Seconds 15
        }
        if (-not $asked) { throw "GitHub did not take the page build request (gh api POST pages/builds)" }
        $askedAt = (Get-Date).ToUniversalTime().AddMinutes(-1)
        Set-Content -LiteralPath (Join-Path $Build 'build-asked-at.txt') -Value $askedAt.ToString('o') -Encoding UTF8
        New-Item -ItemType Directory -Force $instDir | Out-Null
        $b = (Get-Content -LiteralPath (Join-Path $Build $stamp) -Raw | ConvertFrom-Json).build
        [ordered]@{ target = 'AVNI-PULSE'; chain = 'avni-pulse'; commit = $Commit; build = $b; release = $Rc; site = "$Site/"; installedAt = (Get-Date -Format 'dd-MM-yyyy HH:mm') } |
            ConvertTo-Json | Set-Content -LiteralPath $instF -Encoding UTF8
        Write-Host "installed: main on GitHub = $($Commit.Substring(0, 7)) (build $b); Pages build asked for: $asked"
    }
    'verify' {
        Internet 2
        $want = (Get-Content -LiteralPath (Join-Path $Build $stamp) -Raw | ConvertFrom-Json).build
        $since = [datetime]::MinValue
        $askedF = Join-Path $Build 'build-asked-at.txt'
        if (Test-Path -LiteralPath $askedF) { $since = [datetime]::Parse((Get-Content -LiteralPath $askedF -Raw).Trim(), [cultureinfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal) }
        . (Join-Path $sentinelTools 'release\pages_builds.ps1')
        $built = $false; $v = $null
        for ($i = 0; $i -lt 30; $i++) {
            try {
                $list = & gh api "repos/$GhRepo/pages/builds?per_page=30" 2>$null | ConvertFrom-Json
                $v = Get-PagesVerdict $list $Commit $since
                Write-Host "  Pages builds of $($Commit.Substring(0, 7)): $($v.verdict) - $($v.note)"
                if ($v.verdict -eq 'built') { $built = $true; break }
            } catch { Write-Host "  Pages builds could not be read: $_" }
            Start-Sleep -Seconds 10
        }
        if (-not $built -and $v -and $v.verdict -eq 'errored') { throw "GitHub Pages build of $($Commit.Substring(0, 7)) errored: $($v.note)" }
        if (-not $built) { throw "GitHub Pages has not reported a finished build of $($Commit.Substring(0, 7)) within 5 minutes" }
        $ok = $false
        for ($i = 0; $i -lt 84; $i++) {
            $cfg = Fetch "$Site/js/config.js" 3
            if ($cfg -match [regex]::Escape("PULSE_BUILD = '$want'")) {
                $h = Fetch "$Site/host.html" 3
                if ($h -match [regex]::Escape("content=`"$want`"")) { $ok = $true; break }
            }
            Start-Sleep -Seconds 10
        }
        if (-not $ok) { throw "the site does not serve build $want yet (js/config.js, host.html) after 14 minutes - not verified" }
        $live = LiveCommit
        if ($live -ne $Commit) { throw "GitHub main is $live, not the candidate $($Commit.Substring(0, 7))" }
        Write-Host "verified: $Site serves build $want from commit $($Commit.Substring(0, 7)) (config.js and host.html, no cache)"
    }
    'rollback' {
        if (-not (Test-Path -LiteralPath $before)) { throw "no rollback point at $before" }
        $bf = Get-Content -LiteralPath $before -Raw | ConvertFrom-Json
        $prev = $bf.liveCommit
        if (-not $prev) { throw "nothing was live before $Rc - there is no earlier site to go back to (the repository stays as it is)" }
        Internet 5
        GitRetry @('-C', $src, 'push', '--force', $Remote, "${prev}:refs/heads/main") 6 | Out-Null
        try { & gh api -X POST "repos/$GhRepo/pages/builds" 2>$null | Out-Null } catch {}
        [ordered]@{ target = 'AVNI-PULSE'; chain = 'avni-pulse'; commit = $prev; build = $bf.liveBuild; release = "$Rc rolled back"; site = "$Site/"; installedAt = (Get-Date -Format 'dd-MM-yyyy HH:mm') } |
            ConvertTo-Json | Set-Content -LiteralPath $instF -Encoding UTF8
        Write-Host "rolled back: main on GitHub = $($prev.Substring(0, 7)) (what the site served before $Rc)"
    }
}
