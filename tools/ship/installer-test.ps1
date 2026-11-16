# Installs RulZ Kinspora, upgrades it, and uninstalls it, on a CI runner.
# A stand-in profile, tree and packs folder must still be there afterwards,
# byte for byte. The first install is silent with /S only. The upgrade uses the
# arguments the app's own updater passes (--updated /S --force-run), so the
# installer starts the new version itself; the test stops that process and
# removes the files that start created in the profile folder (the folder did
# not exist before this run).
#
# It refuses to start unless GITHUB_ACTIONS is true, or
# -IUnderstandThisInstallsTheApp is passed. It also refuses when it finds the
# owner's data, an existing install, or the folders it would write: it never
# deletes those. After a switch run outside GitHub Actions, it removes the
# three stand-in files and then any folder it created that is empty.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/ship/installer-test.ps1

param(
  [switch]$IUnderstandThisInstallsTheApp
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

function Say([string]$Message) {
  Write-Output "installer-test: $Message"
}

function Fail([string]$Message) {
  [Console]::Error.WriteLine("installer-test: $Message")
  exit 1
}

function Test-Ci {
  return $env:GITHUB_ACTIONS -eq 'true'
}

function Get-Prop($Object, [string]$Name) {
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) { return '' }
  return [string]$property.Value
}

function Test-Under([string]$Path, [string]$Root) {
  $full = [System.IO.Path]::GetFullPath($Path)
  $rootFull = [System.IO.Path]::GetFullPath($Root)
  if (-not $rootFull.EndsWith('\')) { $rootFull += '\' }
  return $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)
}

function Same-Path([string]$Left, [string]$Right) {
  $a = [System.IO.Path]::GetFullPath($Left).TrimEnd('\')
  $b = [System.IO.Path]::GetFullPath($Right).TrimEnd('\')
  return $a.Equals($b, [StringComparison]::OrdinalIgnoreCase)
}

function Get-KinsporaUninstall {
  # Per-user, per-machine, and the 32-bit (WOW6432Node) view of each.
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  $found = @()
  foreach ($rootKey in $roots) {
    if (-not (Test-Path -LiteralPath $rootKey)) { continue }
    foreach ($item in @(Get-ChildItem -LiteralPath $rootKey -ErrorAction SilentlyContinue)) {
      $props = $null
      try {
        $props = Get-ItemProperty -LiteralPath $item.PSPath -ErrorAction Stop
      } catch {
        $props = $null
      }
      if ($null -ne $props -and (Get-Prop $props 'DisplayName') -like 'RulZ Kinspora*') {
        $found += $props
      }
    }
  }
  if ($found.Count -gt 1) { Fail "found $($found.Count) RulZ Kinspora uninstall keys" }
  if ($found.Count -eq 1) { return $found[0] }
  return $null
}

function Assert-OwnerDataAbsent([string]$Documents) {
  $checks = @(
    @{ Path = (Join-Path $env:APPDATA 'RulZ Kinspora\app.db'); Why = 'the app database' },
    @{ Path = (Join-Path $env:APPDATA 'RulZ Ancestry'); Why = 'the previous profile folder' },
    @{ Path = (Join-Path $env:APPDATA 'RulZ Kinspora'); Why = 'the profile folder' },
    @{ Path = (Join-Path $Documents 'RulZ Kinspora'); Why = 'the trees folder' },
    @{ Path = (Join-Path $env:LOCALAPPDATA 'RulZKinspora'); Why = 'the packs folder' },
    @{ Path = (Join-Path $env:LOCALAPPDATA 'Programs\RulZ Kinspora'); Why = 'an existing install' }
  )
  foreach ($check in $checks) {
    if (Test-Path -LiteralPath $check.Path) {
      Fail "refusing to run: $($check.Path) already exists ($($check.Why)) and this test did not create it"
    }
  }
  $installed = Get-KinsporaUninstall
  if ($null -ne $installed) {
    Fail "refusing to run: RulZ Kinspora is already registered to uninstall ($(Get-Prop $installed 'DisplayName'))"
  }
}

function Assert-RealDatabaseStaysAbsent {
  $database = Join-Path $env:APPDATA 'RulZ Kinspora\app.db'
  if (Test-Path -LiteralPath $database) {
    Fail "refusing to continue: $database exists and this test did not create it"
  }
  $oldProfile = Join-Path $env:APPDATA 'RulZ Ancestry'
  if (Test-Path -LiteralPath $oldProfile) {
    Fail "refusing to continue: $oldProfile exists and this test did not create it"
  }
}

function Read-Version([string]$Path) {
  $parsed = [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json
  return [string](Get-Prop $parsed 'version')
}

function Get-NextPatch([string]$Version) {
  if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    Fail "apps/desktop/package.json version must be x.y.z so a second installer can be built, found $Version"
  }
  return "$($Matches[1]).$($Matches[2]).$([int]$Matches[3] + 1)"
}

function Get-Sha256([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)) }
  finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

function Resolve-Pnpm {
  foreach ($name in @('pnpm.cmd', 'pnpm.exe', 'pnpm')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { return $cmd.Source }
  }
  Fail 'pnpm is not on PATH'
}

function Invoke-Pnpm([string[]]$PnpmArgs) {
  & $script:Pnpm @PnpmArgs
  if ($LASTEXITCODE -ne 0) {
    Fail ("pnpm {0} failed with exit code {1}" -f ($PnpmArgs -join ' '), $LASTEXITCODE)
  }
}

function Get-SetupPath([string]$Root, [string]$Version) {
  $path = Join-Path $Root "apps\desktop\release\RulZ-Kinspora-Setup-$Version.exe"
  if (-not (Test-Path -LiteralPath $path)) { Fail "expected installer was not produced: $path" }
  return $path
}

function Install-Silent([string]$Installer, [string[]]$InstallerArgs = @('/S')) {
  Say "installing $Installer ($($InstallerArgs -join ' '))"
  # Not -Wait: in Windows PowerShell 5.1 that waits for every descendant too, and with
  # --force-run the installer starts the app, which would keep this call waiting forever.
  $proc = Start-Process -FilePath $Installer -ArgumentList $InstallerArgs -PassThru -WindowStyle Hidden
  $null = $proc.Handle
  if (-not $proc.WaitForExit(300000)) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Fail "installer did not finish within 5 minutes: $Installer"
  }
  if ($proc.ExitCode -ne 0) { Fail "installer exited $($proc.ExitCode): $Installer" }
}

function Get-InstalledAppProcesses([string]$InstallDir) {
  return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $path = $null
    try { $path = $_.Path } catch { $path = $null }
    $path -and (Test-Under $path $InstallDir)
  })
}

# --force-run starts the app after the install. Wait for it, so that the test
# knows the option worked, then stop it and wait until its files are free.
function Stop-ForceRunApp([string]$InstallDir) {
  $deadline = (Get-Date).AddSeconds(60)
  $running = @()
  do {
    $running = @(Get-InstalledAppProcesses $InstallDir)
    if ($running.Count -gt 0) { break }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  if ($running.Count -eq 0) { Fail '--force-run did not start the app after the upgrade' }
  Say 'the upgrade started the new version by itself; stopping it'
  $deadline = (Get-Date).AddSeconds(60)
  do {
    foreach ($process in (Get-InstalledAppProcesses $InstallDir)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
  } while (@(Get-InstalledAppProcesses $InstallDir).Count -gt 0 -and (Get-Date) -lt $deadline)
  if (@(Get-InstalledAppProcesses $InstallDir).Count -gt 0) { Fail 'the started app did not stop' }
}

# Removes everything below $Root except the stand-in file $Keep and the folders on the way to
# it. The three roots did not exist before this run (Assert-OwnerDataAbsent checked), so
# whatever else is in them was written by the app the upgrade started.
function Remove-Extras([string]$Root, [string]$Keep) {
  if (-not (Test-Path -LiteralPath $Root)) { return }
  foreach ($item in @(Get-ChildItem -LiteralPath $Root -Force)) {
    if (Same-Path $item.FullName $Keep) { continue }
    if ($item.PSIsContainer -and (Test-Under $Keep $item.FullName)) {
      Remove-Extras $item.FullName $Keep
      continue
    }
    Remove-Item -LiteralPath $item.FullName -Recurse -Force
  }
}

function Remove-RelaunchFiles([string]$ProfileFile, [string]$TreeFile, [string]$PackFile) {
  $roots = @(
    @{ Root = (Split-Path -Parent $ProfileFile); Keep = $ProfileFile },
    @{ Root = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'RulZ Kinspora'); Keep = $TreeFile },
    @{ Root = (Join-Path $env:LOCALAPPDATA 'RulZKinspora'); Keep = $PackFile }
  )
  foreach ($entry in $roots) { Remove-Extras $entry.Root $entry.Keep }
}

function Get-RegisteredUninstaller($Info) {
  foreach ($raw in @((Get-Prop $Info 'QuietUninstallString'), (Get-Prop $Info 'UninstallString'))) {
    if ($raw -match '^"([^"]+\.exe)"') { return $Matches[1] }
  }
  Fail 'the uninstall registry key has no UninstallString'
}

function Wait-Installed([string]$ExpectedVersion, [string]$Programs) {
  $deadline = (Get-Date).AddSeconds(60)
  $info = $null
  do {
    $info = Get-KinsporaUninstall
    if ($null -ne $info -and (Get-Prop $info 'DisplayVersion') -eq $ExpectedVersion) { break }
    Start-Sleep -Seconds 1
    $info = $null
  } while ((Get-Date) -lt $deadline)
  if ($null -eq $info) {
    $found = Get-KinsporaUninstall
    $actual = if ($null -eq $found) { '(no uninstall key)' } else { Get-Prop $found 'DisplayVersion' }
    Fail "expected RulZ Kinspora $ExpectedVersion to be registered, found $actual"
  }

  $fromReg = Get-RegisteredUninstaller $info
  if (-not (Test-Path -LiteralPath $fromReg)) { Fail "registered uninstaller is missing: $fromReg" }
  $installDir = Split-Path -Parent $fromReg
  $expectedDir = Join-Path $Programs 'RulZ Kinspora'
  if (-not (Same-Path $installDir $expectedDir)) {
    Fail "app files are in $installDir, not under $expectedDir"
  }
  $inFolder = @(Get-ChildItem -LiteralPath $installDir -Filter 'Uninstall *.exe' -File)
  if ($inFolder.Count -ne 1) {
    Fail "expected one Uninstall *.exe in $installDir, found $($inFolder.Count)"
  }
  if (-not (Same-Path $fromReg $inFolder[0].FullName)) {
    Fail "registry uninstaller $fromReg is not $($inFolder[0].FullName)"
  }
  $exe = Join-Path $installDir 'RulZ Kinspora.exe'
  if (-not (Test-Path -LiteralPath $exe)) { Fail "the app executable is missing: $exe" }
  return @{ InstallDir = $installDir; Uninstaller = $inFolder[0].FullName; Exe = $exe }
}

function Uninstall-Silent([string]$Uninstaller, [string]$InstallDir, [string]$Programs) {
  if (-not (Test-Under $Uninstaller $Programs)) {
    Fail "refusing to run an uninstaller outside $Programs`: $Uninstaller"
  }
  Say "uninstalling $Uninstaller"
  # QuietUninstallString is `"<uninstaller>" /currentuser /S`. The copy NSIS
  # starts can outlive the process -Wait would see, so the folder is the check.
  $proc = Start-Process -FilePath $Uninstaller -ArgumentList '/currentuser /S' -PassThru -WindowStyle Hidden
  $deadline = (Get-Date).AddMinutes(5)
  while ((Test-Path -LiteralPath $InstallDir) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
  }
  if (-not $proc.HasExited) { [void]$proc.WaitForExit(15000) }
  if (Test-Path -LiteralPath $InstallDir) {
    $code = if ($proc.HasExited) { $proc.ExitCode } else { 'still running' }
    Fail "install folder still exists after uninstall (uninstaller exit $code): $InstallDir"
  }
}

function Wait-Uninstalled {
  # NSIS copies the uninstaller to temp. That copy can delete the registry key
  # after the install folder is already gone.
  $deadline = (Get-Date).AddSeconds(60)
  do {
    if ($null -eq (Get-KinsporaUninstall)) { return }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  Fail 'the uninstall registry key is still present'
}

function Remove-FolderIfEmpty([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  # Immediate children only. Leave a folder that still has anything in it.
  if (@(Get-ChildItem -LiteralPath $Path -Force).Count -ne 0) { return }
  Remove-Item -LiteralPath $Path
}

function New-StandIn([string]$File, [string]$Text) {
  $parent = Split-Path -Parent $File
  if (Test-Path -LiteralPath $parent) {
    Fail "refusing to write $File because $parent already exists"
  }
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($File, $Text, $utf8)
  # The comma keeps PowerShell from unrolling the byte array into the pipeline.
  return , [System.IO.File]::ReadAllBytes($File)
}

function Assert-SameBytes([string]$Label, [string]$Path, [byte[]]$Expected) {
  if (-not (Test-Path -LiteralPath $Path)) { Fail "$Label is missing: $Path" }
  $actual = [System.IO.File]::ReadAllBytes($Path)
  if ($actual.Length -ne $Expected.Length) {
    Fail "$Label changed length: expected $($Expected.Length) bytes, found $($actual.Length) ($Path)"
  }
  for ($i = 0; $i -lt $actual.Length; $i++) {
    if ($actual[$i] -ne $Expected[$i]) { Fail "$Label differs at byte $i ($Path)" }
  }
}

if (-not $PSScriptRoot) { Fail 'run this script as a file, not by pasting it' }

if (-not (Test-Ci) -and -not $IUnderstandThisInstallsTheApp) {
  Fail 'This installs and uninstalls RulZ Kinspora. It runs when GITHUB_ACTIONS is true, or with -IUnderstandThisInstallsTheApp. It was not started.'
}

if ([string]::IsNullOrWhiteSpace($env:APPDATA) -or [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  Fail 'APPDATA and LOCALAPPDATA must be set'
}
$documents = [Environment]::GetFolderPath('MyDocuments')
if ([string]::IsNullOrWhiteSpace($documents)) { Fail 'the Documents folder is not set' }

Assert-OwnerDataAbsent $documents
Say 'no existing profile, trees, packs or install were found'

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $Root
$script:Pnpm = Resolve-Pnpm

$version = Read-Version (Join-Path $Root 'apps\desktop\package.json')
$next = Get-NextPatch $version
Say "building installers $version and $next"

Invoke-Pnpm @('build')
Invoke-Pnpm @('--filter', '@rulz/desktop', 'exec', 'electron-builder', '--win', 'nsis', '--x64', '--publish', 'never')
$first = Get-SetupPath $Root $version
Install-Silent $first

$programs = Join-Path $env:LOCALAPPDATA 'Programs'
$installed = Wait-Installed $version $programs
Say "version $version is under $($installed.InstallDir)"
Assert-RealDatabaseStaysAbsent

$stamp = [guid]::NewGuid().ToString('n')
$profileFile = Join-Path (Join-Path $env:APPDATA 'RulZ Kinspora') 'installer-test.txt'
$treeFile = Join-Path (Join-Path (Join-Path $documents 'RulZ Kinspora') 'Test tree') 'installer-test.txt'
$packFile = Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA 'RulZKinspora') 'packs') 'installer-test.txt'
$profileBytes = New-StandIn $profileFile "profile stand-in $stamp`r`n"
$treeBytes = New-StandIn $treeFile "tree stand-in $stamp`r`n"
$packBytes = New-StandIn $packFile "packs stand-in $stamp`r`n"
Say 'stand-in profile, tree and packs are in place'

$preserved = @(
  (Join-Path $Root 'package.json'),
  (Join-Path $Root 'apps\desktop\package.json'),
  (Join-Path $Root 'apps\desktop\electron-builder.yml')
)
$before = @{}
foreach ($path in $preserved) { $before[$path] = Get-Sha256 $path }

# The second installer is a higher version only for this build. The files stay as they are.
Invoke-Pnpm @(
  '--filter', '@rulz/desktop', 'exec', 'electron-builder',
  '--win', 'nsis', '--x64', '--publish', 'never',
  "-c.extraMetadata.version=$next"
)
foreach ($path in $preserved) {
  if ((Get-Sha256 $path) -ne $before[$path]) { Fail "the second build changed $path" }
}
$second = Get-SetupPath $Root $next
Install-Silent $second @('--updated', '/S', '--force-run')
$upgraded = Wait-Installed $next $programs
if (-not (Same-Path $upgraded.InstallDir $installed.InstallDir)) {
  Fail "the upgrade installed to $($upgraded.InstallDir) instead of $($installed.InstallDir)"
}
Stop-ForceRunApp $upgraded.InstallDir
# The relaunched app used the real profile, so it wrote its database there. That is the
# profile this test made, and it is removed next; the check below then proves it is gone.
$relaunchDb = Join-Path $env:APPDATA 'RulZ Kinsporapp.db'
if (Test-Path -LiteralPath $relaunchDb) { Say 'the relaunched app wrote its database; removing it' }
Remove-RelaunchFiles $profileFile $treeFile $packFile
Assert-RealDatabaseStaysAbsent
Assert-SameBytes 'profile' $profileFile $profileBytes
Assert-SameBytes 'tree' $treeFile $treeBytes
Assert-SameBytes 'packs' $packFile $packBytes
Assert-RealDatabaseStaysAbsent
Say "version $next kept the profile, tree and packs"

Uninstall-Silent $upgraded.Uninstaller $upgraded.InstallDir $programs
Wait-Uninstalled
if (Test-Path -LiteralPath $upgraded.Exe) { Fail "the app executable is still there: $($upgraded.Exe)" }
Assert-SameBytes 'profile' $profileFile $profileBytes
Assert-SameBytes 'tree' $treeFile $treeBytes
Assert-SameBytes 'packs' $packFile $packBytes
Assert-RealDatabaseStaysAbsent
Say 'uninstalled. The profile, tree and packs are unchanged, and the install folder is gone.'

# A switch run on a person's machine removes only what this run created.
if ($IUnderstandThisInstallsTheApp -and -not (Test-Ci)) {
  Remove-Item -LiteralPath $profileFile
  Remove-Item -LiteralPath $treeFile
  Remove-Item -LiteralPath $packFile
  foreach ($dir in @(
    (Join-Path (Join-Path $documents 'RulZ Kinspora') 'Test tree'),
    (Join-Path $documents 'RulZ Kinspora'),
    (Join-Path $env:APPDATA 'RulZ Kinspora'),
    (Join-Path (Join-Path $env:LOCALAPPDATA 'RulZKinspora') 'packs'),
    (Join-Path $env:LOCALAPPDATA 'RulZKinspora')
  )) {
    Remove-FolderIfEmpty $dir
  }
}
