# Installs or updates the standalone nova-ai binary from its GitHub release, for Windows.
#
#   irm https://datalabrotterdam.nl/nova-ai/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://datalabrotterdam.nl/nova-ai/install.ps1))) -Channel alpha
#
# Run it again to update. Parameters: -Channel latest|alpha, -Version <v>, -Dir <folder>, -Force.
# New installs go to %LOCALAPPDATA%\Programs\nova-ai (or NOVA_AI_INSTALL_DIR) and that folder is
# added to your user PATH. No admin rights, no Node or npm.
param(
  [string]$Channel = "latest",
  [string]$Version = $env:NOVA_AI_VERSION,
  [string]$Dir = $env:NOVA_AI_INSTALL_DIR,
  [switch]$Force
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoUrl = "https://github.com/Datalab-Rotterdam/nova-ai-cli"
$TagPrefix = "@datalabrotterdam/nova-ai-cli@"

function Fail($message) { throw "nova-ai install: $message" }

if ("$Channel$Version" -notmatch '^[0-9A-Za-z.+-]*$') { Fail "invalid channel or version." }

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  "AMD64" { "x64" }
  "ARM64" { "arm64" }
  default { Fail "no binary for $($env:PROCESSOR_ARCHITECTURE)." }
}
# A 32-bit PowerShell on 64-bit Windows reports x86 in PROCESSOR_ARCHITECTURE.
if ($env:PROCESSOR_ARCHITEW6432 -eq "AMD64") { $arch = "x64" }
if ($env:PROCESSOR_ARCHITEW6432 -eq "ARM64") { $arch = "arm64" }

if (-not $Version) {
  # The newest release of this package; "latest" skips prereleases. Needs no Node or npm.
  $releases = Invoke-RestMethod "https://api.github.com/repos/Datalab-Rotterdam/nova-ai-cli/releases?per_page=100"
  $pick = $releases | Where-Object { $_.tag_name.StartsWith($TagPrefix) -and ($Channel -ne "latest" -or -not $_.prerelease) } | Select-Object -First 1
  if (-not $pick) { Fail "no $Channel release found. Releases: $RepoUrl/releases" }
  $Version = $pick.tag_name.Substring($TagPrefix.Length)
}

# Update the copy on PATH when there is one, otherwise the default folder.
$existing = Get-Command nova-ai.exe -ErrorAction SilentlyContinue
if (-not $Dir) {
  if ($existing -and $existing.Source -notmatch "node_modules") { $Dir = Split-Path $existing.Source }
  else { $Dir = Join-Path $env:LOCALAPPDATA "Programs\nova-ai" }
}
$target = Join-Path $Dir "nova-ai.exe"

$current = $null
if (Test-Path $target) {
  $env:NOVA_NO_UPDATE_CHECK = "1"
  try { $current = ((& $target --version 2>$null) -replace "^nova-ai ", "").Trim() } catch { }
}
if ($current -eq $Version -and -not $Force) {
  Write-Host "nova-ai $Version is already installed at $target. Nothing to do (-Force reinstalls)."
  return
}
if ($current) { Write-Host "Updating nova-ai $current -> $Version at $target" }

$asset = "nova-ai-windows-$arch.zip"
$base = if ($env:NOVA_AI_DOWNLOAD_URL) { $env:NOVA_AI_DOWNLOAD_URL } else { "$RepoUrl/releases/download/%40datalabrotterdam%2Fnova-ai-cli%40$Version" }
$work = Join-Path ([IO.Path]::GetTempPath()) ("nova-ai-install-" + [guid]::NewGuid())
New-Item -ItemType Directory $work | Out-Null
try {
  Write-Host "Downloading nova-ai $Version for windows-$arch..."
  try {
    Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $work "SHA256SUMS")
    Invoke-WebRequest "$base/$asset" -OutFile (Join-Path $work $asset)
  } catch { Fail "nova-ai $Version has no binaries. Releases: $RepoUrl/releases" }

  $line = Get-Content (Join-Path $work "SHA256SUMS") | Where-Object { $_ -match "^[0-9a-f]{64} [ *]$([regex]::Escape($asset))$" } | Select-Object -First 1
  if (-not $line) { Fail "$asset is not listed in SHA256SUMS." }
  $actual = (Get-FileHash (Join-Path $work $asset) -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $line.Substring(0, 64)) { Fail "$asset does not match its checksum. Nothing was installed." }

  Expand-Archive (Join-Path $work $asset) -DestinationPath (Join-Path $work "unpacked")
  New-Item -ItemType Directory -Force $Dir | Out-Null
  # Beside the target: a running nova-ai.exe cannot be overwritten but can be renamed away.
  $fresh = Join-Path $Dir ".nova-ai-install.exe"
  Copy-Item (Join-Path $work "unpacked\nova-ai.exe") $fresh -Force
  $env:NOVA_NO_UPDATE_CHECK = "1"
  $reported = (& $fresh --version 2>&1) | Out-String
  if ($reported.Trim() -ne "nova-ai $Version") { Remove-Item $fresh -Force; Fail "expected nova-ai $Version, the binary reported: $reported" }
  if (Test-Path $target) { Move-Item $target (Join-Path $Dir ".nova-ai-old.exe") -Force }
  Move-Item $fresh $target -Force
  Remove-Item (Join-Path $Dir ".nova-ai-old.exe") -Force -ErrorAction SilentlyContinue
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

$verb = if ($current) { "Updated" } else { "Installed" }
Write-Host "$verb nova-ai $Version at $target"

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $Dir) {
  [Environment]::SetEnvironmentVariable("Path", (($userPath, $Dir) | Where-Object { $_ }) -join ";", "User")
  Write-Host "Added $Dir to your PATH. Open a new terminal, then run: nova-ai login"
} else {
  Write-Host "Next: nova-ai login"
}
