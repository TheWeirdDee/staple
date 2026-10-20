# Release work and acceptance evidence

Repository fixes do not establish live integration, security approval, or customer adoption.
Keep `submission-facts.json` pending until the corresponding evidence exists.

| Work | Prerequisite | Acceptance evidence |
| --- | --- | --- |
| Deploy on Elysium testnet | Owner-supplied encrypted keystore including deployer, funded deployer | Successful receipts, chain ID 99801, deployed code at each address; `runs/deployment-testnet.json` and `web/public/deployment.json` |
| Real G1 loop | Funded dedicated owner, both agents approved, deployment | Intent transaction, accepted order ID/client ID, independent watcher observation, cancel confirmation, reconciled terminal on-chain outcome in `runs/g1/manifest.json` |
| Agent lifecycle | Owner wallet access | Agent listing before approval, after approval and after revocation; separate confirmation that all resting orders are terminal |
| Shutdown and recovery | G1 completed, bounded testnet inventory | Raw watcher/keeper/exchange logs for stale feed, delayed cancel with late fill, outage/restart, and mismatch; case-specific timestamps and reconciled outcomes |
| Owner browser checks | Live deployment and owner wallet | Browser evidence of publish, approve, activate, pause pending/confirmed, exit pending/confirmed; screenshots and transaction references |
| Campaign and demo | Stable live services, frozen method in metrics.md | ABBA observations, coverage/gaps, latency and reconciliation metrics, raw-file hashes, actual duration, limitations, and recorded demo footage |
| Independent security review | External reviewer selected and repository commit frozen | Reviewer-authored report, scoped commit, findings and remediation sign-off; internal checks are not independent review |
| Production key management | Cloud provider/account and signer requirements selected | KMS/HSM signing implementation, permissions, rotation/recovery exercise and key isolation evidence; existing file encryption remains prototype-only |
| Monitoring separation | Separate host/account access | Watcher deployed independently, separate keys and alerts, keeper-host outage exercise; current shared GitHub runner is not separated |
| Pilot | Named participant and agreed capital/operational limits | Participant agreement, operating window, incident ownership, measured outcomes; no outreach or adoption is claimed |

## Local verification

1. `pnpm install --frozen-lockfile`.
2. Install `python-requirements.lock` in `.venv` and select its Python with `STAPLE_PYTHON`.
3. Install Foundry 1.7.1 (`forge`, `anvil`) on PATH.
4. `pnpm build`, then `pnpm test:offline`. The latter writes current results and exits nonzero on missing tools, failing suites, or zero tests.
5. Install Playwright Chromium and run `pnpm e2e`. This uses a local chain and an exchange test double and must never be labelled live verification.
6. `pnpm check:readiness` records network/prerequisite checks to `runs/readiness.json`. Provide public role addresses to check actual balances. Unknown balance is not evidence of insufficient funds.
7. Only publish updated evidence after reviewing the generated records: `pnpm evidence`.

## Access needed

The local recovery restored the signing credentials under `.secrets/` and verified the existing Elysium deployment. See `docs/local-recovery.md` for commands. Owner Hyperliquid testnet USDC is still missing; the real exchange loop and campaign remain pending.
Supply cloud account/region, reviewer engagement, and pilot participant details before their dependent work.
Do not replace missing live records with fabricated manifests, measurements, or demo footage.
