# Deployment and operations runbook (testnet)

Everything here targets Elysium testnet (chain 99801) and Hyperliquid testnet. `keeper/src/config.ts` refuses to
start on any other network.

## 0. Prerequisites

- Node 22 with pnpm 10, Python 3.11+, and Foundry 1.7 (`npm i @foundry-rs/forge@1.7.1` works where GitHub
  release downloads are blocked).
- `pnpm install` at the repo root, then `pip install -r python-requirements.lock`.

## 1. Keys

| Key | Purpose | Funding |
| --- | --- | --- |
| deployer | Deploys contracts, distributes gas | Elysium testnet HYPE (faucet) |
| operator | Keeper reporter: signs observations and outcomes, sends their txs | Elysium HYPE (from deployer) |
| watcher | Guardian: heartbeat, poke, mismatch, revocation txs | Elysium HYPE (from deployer) |
| agent | HyperCore agent the owner approves; signs orders and cancels | none (agents never hold funds) |
| guard | Separate HyperCore agent for watcher emergency cancels | none |
| owner | Demo owner: holds trading capital on HyperCore, signs approvals | Testnet USDC (faucet) + Elysium HYPE |
| taker | Labelled controlled taker for the campaign | USDC/PURR sent by the owner |

Build the encrypted keystore (scrypt + AES-256-GCM, random 256-bit passphrase):

```bash
cd keeper && npx tsx src/ops.ts keystore /path/to/keys.json ../.secrets/keystore.json
```

`keys.json` maps names to `{ "key": "0x…" }`. Keep `.secrets/` out of git (it is ignored). The keeper and watcher
read `STAPLE_KEYSTORE` and `STAPLE_KEYSTORE_PASSPHRASE`. Keys are decrypted in memory only and redacted from logs.
This is file encryption, not KMS.

## 2. Deploy and create the mandate

```bash
export STAPLE_KEYS_JSON=/path/to/keys.json          # or STAPLE_KEYSTORE + STAPLE_KEYSTORE_PASSPHRASE
cd keeper
npx tsx src/ops.ts fund-gas 0.2                     # deployer → operator, watcher, owner
npx tsx src/ops.ts deploy                           # writes runs/deployment-testnet.json and web/public/deployment.json
npx tsx src/ops.ts create-mandate 96                # campaign policy, 96 h expiry, deposits 50 tFEE
npx tsx src/ops.ts owner-trade buy 30               # owner buys starting inventory (IOC, not a Staple action)
npx tsx src/ops.ts approve-agent keeper             # named agent staple-<id>, 30-day expiry
npx tsx src/ops.ts approve-agent guard              # named agent staple-guard-<id>
npx tsx src/ops.ts agents                           # confirm both are listed on HyperCore
```

Commit the two deployment files (one per commit) so the site and services pick them up.

Measured on Elysium testnet (base fee 0.1 gwei, October 2026):

| Action | Gas used | Testnet HYPE |
| --- | --- | --- |
| Full deploy (3 libraries, fee token, registry, desk, bind) | — | 0.0012 total |
| Keeper tick (observation + decision) | ~190k | ~0.000019 |
| Watcher heartbeat | ~39k | ~0.000004 |
| Watcher poke that halts a stale mandate | ~70k | ~0.000007 |
| Owner activate / pause | 161k / 45k | ~0.000016 / ~0.000005 |

A 24 h campaign ticking every 5 s needs about 0.35 HYPE for the operator key, and the watcher needs about 0.1 HYPE
at a 10 s interval. Ask the Elysium faucet repeatedly or top up from the deployer before a campaign.

The Hyperliquid testnet USDC faucet only pays addresses that have used Hyperliquid mainnet. Without that, the
owner account needs testnet USDC sent by someone else.

## 3. Run the services

### Hosted (GitHub Actions)

1. Add repository secrets `STAPLE_KEYSTORE_B64` (`base64 -w0 .secrets/keystore.json`) and
   `STAPLE_KEYSTORE_PASSPHRASE`.
2. Commit `deploy/services.env`. Keeper, watcher and sampler only:
   ```
   STAPLE_RUN_MINUTES=340
   STAPLE_CAMPAIGN_ID=g1
   ```
   For a campaign, add `STAPLE_CAMPAIGN_START=<unix s>`, `STAPLE_CAMPAIGN_END=<unix s>`, `STAPLE_BLOCK_MIN=30` and
   `STAPLE_TAKER_EVERY_MIN=15`.
3. The `Testnet services` workflow then runs on its schedule. Each run lasts about 5h40m. The concurrency group
   keeps one run active and one queued, so the next run starts when the current one ends.
4. Raw data goes to the `campaign-data` branch, one file per commit. Keeper and watcher state is handed over
   through the Actions cache.

A handover gap (about 1–3 minutes) is expected. During it, the exchange-side scheduled cancel removes resting
orders and the on-chain watchdog halts quoting on the next poke. On start, the keeper reconciles before any new
exposure.

### Any Linux host

```bash
STAPLE_KEYSTORE=… STAPLE_KEYSTORE_PASSPHRASE=… STAPLE_RUN_MINUTES=100000 deploy/run-services.sh
```

Run it under systemd with `Restart=always`. The script supervises each service, restarting it on failure.

## 4. Health checks

- Keeper: `GET :8787` returns `{ ok, lastOkAt, consecutiveErrors, recovered }` (503 when stale).
- Watcher: `GET :8788` returns `{ ok, state, coverage }` (503 when stale).
- On-chain: the public page shows watcher heartbeat age and reference age. With no heartbeat for
  `watcherTimeoutSec`, quoting fails closed.
- `state/health.jsonl` records both endpoints every minute; `state/supervisor.jsonl` records every restart.

## 5. Owner operations

| Action | Command / UI |
| --- | --- |
| Pause | `ops.ts pause` or console → Pause. State shows PAUSING until every cancel is confirmed. |
| Resume | `ops.ts activate` (only from PAUSED with no live orders; takes a fresh snapshot) |
| Edit policy | Console → Edit (diff shown; risk-increasing changes wait 60 s) |
| Re-arm after a trip | `ops.ts rearm` (moves to PAUSED only) |
| Cancel all and revoke | Console → Exit, five confirmed steps, or `requestRevoke` → wait for orders → `revoke-agent keeper` → `agents` → `reportAgentRevoked` |

## 6. Emergency shutdown

In order of preference:

1. **Owner pause** (Elysium): stops new intents at once; the keeper cancels.
2. **Keeper down?** The watcher cancels with the guard agent once the keeper has been silent for
   `STAPLE_KEEPER_TIMEOUT_SEC` (60 s). The exchange-side scheduled cancel fires at most 90 s after the last
   renewal (Hyperliquid limits it to 10 triggers per day).
3. **Keeper key suspected compromised:** revoke the agent first (`revoke-agent keeper`, or the Hyperliquid app
   → API), then cancel the remaining orders directly in the Hyperliquid app with the owner wallet. Revoking does
   not cancel resting orders. Pausing does not revoke.
4. Shutdown never sells inventory. Residual holdings stay in the owner account and keep their market risk.

## 7. Key rotation

1. Pause the mandate and wait for PAUSED (no live orders).
2. Keeper reporter or watcher key: `MandateRegistry.setRoles(id, newOperator, newGuardian)` (allowed only while
   quiescent).
3. Agent key: approve a new agent address under the same name (this replaces it), then confirm with `ops.ts agents`.
   Hyperliquid advises against reusing agent addresses.
4. Rebuild the keystore, update the secrets, and re-activate.

## 8. Restart behaviour

Every restart begins with recovery. The keeper queries the exchange for every live intent, ingests unseen fills
and resolves unknown placements only after their exchange expiry. It executes no intent until this completes.
The watcher rebuilds its intent map from chain logs. The sampler logs every disconnect and reconnect as gaps.

## 9. Evidence

```bash
scripts/offline-tests.sh                 # runs/offline-tests.json
python sampler/metrics.py --sampler <dir> --states <states.json> --out runs/campaign-<id>/results.json
node scripts/publish-evidence.mjs        # web/public/evidence/index.json
```

## Recovering credentials from a cloud coding workspace

Git cloning does not restore ignored files. If the original keys were created in a
cloud workspace, download its `.secrets/` files securely to the same local directory.
The original session named `.secrets/STAPLE_KEYSTORE_B64.txt` and `.secrets/STAPLE_KEYSTORE_PASSPHRASE.txt`. Do not paste either file into chat or commit them.
GitHub Actions secrets cannot be downloaded back as plaintext.

A `.env` file is not required: the CLI reads process environment variables, and the
hosted workflow reads GitHub Actions secrets. It does not automatically load a root `.env`.
For a downloaded keystore in PowerShell, set `STAPLE_KEYSTORE` to its absolute path
and supply `STAPLE_KEYSTORE_PASSPHRASE` through the process environment or secret store.
If the download contains only the base64 file, decode it locally:

```powershell
[IO.File]::WriteAllBytes("$PWD/.secrets/keystore.json", [Convert]::FromBase64String([IO.File]::ReadAllText("$PWD/.secrets/STAPLE_KEYSTORE_B64.txt")))
$env:STAPLE_KEYSTORE = "$PWD/.secrets/keystore.json"
# Supply STAPLE_KEYSTORE_PASSPHRASE separately; do not print it.
```

Do not fund the old public addresses until their signing keys have been recovered.
If the cloud files are unavailable, generate fresh dedicated testnet identities and
update all role addresses before requesting new funding.
