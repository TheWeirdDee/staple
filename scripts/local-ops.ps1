param(
  [ValidateSet('balances', 'agents', 'fund-watcher', 'readiness')]
  [string]$Command = 'balances'
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$savedKeysPath = $env:STAPLE_KEYS_JSON
$savedKeystore = $env:STAPLE_KEYSTORE
$savedPassphrase = $env:STAPLE_KEYSTORE_PASSPHRASE
Push-Location $repoRoot
try {
  if ($Command -eq 'fund-watcher') {
    Remove-Item Env:STAPLE_KEYSTORE -ErrorAction SilentlyContinue
    Remove-Item Env:STAPLE_KEYSTORE_PASSPHRASE -ErrorAction SilentlyContinue
    $env:STAPLE_KEYS_JSON = Join-Path $repoRoot '.secrets/keys.json'
    & pnpm.cmd --filter '@staple/keeper' exec tsx src/ops.ts fund-gas 0.05 watcher
  } else {
    Remove-Item Env:STAPLE_KEYS_JSON -ErrorAction SilentlyContinue
    $env:STAPLE_KEYSTORE = Join-Path $repoRoot '.secrets/keystore.json'
    $env:STAPLE_KEYSTORE_PASSPHRASE = [IO.File]::ReadAllText((Join-Path $repoRoot '.secrets/STAPLE_KEYSTORE_PASSPHRASE.txt')).Trim()
    if ($Command -eq 'readiness') {
      $publicRoles = Get-Content (Join-Path $repoRoot 'runs/recovery-addresses.json') -Raw | ConvertFrom-Json
      foreach ($role in @('DEPLOYER', 'OPERATOR', 'WATCHER', 'OWNER')) {
        [Environment]::SetEnvironmentVariable("STAPLE_${role}_ADDRESS", $publicRoles.($role.ToLower()), 'Process')
      }
      & node scripts/readiness.mjs
    } else {
      & pnpm.cmd --filter '@staple/keeper' exec tsx src/ops.ts $Command
    }
  }
  if ($LASTEXITCODE -ne 0) { throw "Staple operation failed with exit code $LASTEXITCODE" }
} finally {
  $env:STAPLE_KEYS_JSON = $savedKeysPath
  $env:STAPLE_KEYSTORE = $savedKeystore
  $env:STAPLE_KEYSTORE_PASSPHRASE = $savedPassphrase
  Pop-Location
}
