# Local recovery

The cloud recovery bundle has been restored in this checkout. Credentials are in
`.secrets/`, which is ignored by Git and restricted to the current Windows user.
The credential archive is also stored inside `.secrets/`. No credential values
were printed or committed. All 73 manifest entries were verified; all seven
key/address pairs and all six encrypted roles matched.

Keep `keys.json`: the encrypted keystore intentionally excludes the deployer.
The original recovery instructions and manifest remain unchanged inside
`.secrets/RECOVERY.md` and `.secrets/MANIFEST.md`.

The public configuration is at `deploy/services.env`. Recovered local-only
observations are under `runs/local-only/`; they are historical partial data,
not a completed campaign. The newer cloud deployment and fixes were reconciled
from `origin/main` at `c6aaddf961822bf08c5d64b522cc64aa8313340c`. Previous local
versions are preserved in `.test-tmp/cloud-merge/local-backup/`.

## Commands

From PowerShell in the repository root:

```powershell
# Read-only; loads credentials into this process and restores the prior environment afterward.
.\scripts\local-ops.ps1 balances
.\scripts\local-ops.ps1 agents
.\scripts\local-ops.ps1 readiness

# Public-source secret scan. The same guard runs on staged files before local commits.
node scripts/check-secrets.mjs --worktree

# Local verification, requiring no trading funds.
pnpm build
$env:STAPLE_PYTHON = "$PWD/.venv/Scripts/python.exe"
pnpm test:offline
pnpm test:tooling
pnpm e2e
```

Readiness exits unsuccessfully while owner Hyperliquid testnet USDC is zero.
This is a funding blocker, not a failing offline test. A positive balance alone
does not establish that a policy has sufficient capital or starting inventory.

`local-ops.ps1 fund-watcher` sends **0.05 testnet HYPE** from the deployer to the
watcher only. It is a transaction, not a read-only check; each invocation sends
another top-up. The top-up performed during this recovery was confirmed as
`0xedb1547e717f3f8eca5c6f97bbd9bf3d96461ddbec3cbafa5eecc0ceabf39cc9`.

## Current state

- Six deployed contracts/libraries were verified on Elysium testnet, chain 99801.
- Mandate 1 is a draft with zero orders.
- The GitHub Actions service workflow is already running. Its two required secret
  names are configured. GitHub does not expose their values for inspection.
- No local keeper or watcher was started for the real mandate.
- The owner has zero Hyperliquid spot funds. G1, live approvals/revocation, exchange
  shutdown/recovery and the campaign cannot be verified until funded.
- Browser owner-flow tests use a separate `e2e-deployment.json` fixture and never
  overwrite the real public deployment record.

Do not run local bots for mandate 1 alongside the hosted bots. Before a funded
campaign, choose one execution host, use the required active watcher cadence,
check service gas budgets and verify starting inventory. No mainnet transactions
or mainnet funds are part of this setup.

The local pre-commit guard rejects credential paths and recovered key/passphrase
values in staged content. Git ignore rules are retained for credentials,
credential archives, local environments and runtime state. Do not force-add
ignored private files.
