# Dependency matrix (verified 2026-10-17)

Checked against primary sources and the live networks from this project's environment. "Observed" means a
request was made and its response is recorded below. Nothing here infers a launch date.

| Dependency | Official source | Network | Observed availability | Test | Fallback in use |
| --- | --- | --- | --- | --- | --- |
| Elysium testnet chain | https://elysium.kinetiq.xyz/docs/building-on-elysium | chain id 99801, RPC `https://testnet-rpc.elysium.kinetiq.xyz` | Live: `eth_chainId` → `0x185d9` (99801), blocks advancing | `eth_chainId`, `eth_blockNumber` | — |
| Elysium explorer | same | `https://elysium.kinetiq.xyz/testnet-explorer` (`/address/…`, `/transaction/…`) | Live (HTTP 200) | page fetch | — |
| Elysium contract size | same (stock ArbOS) | 99801 | 24,576-byte limit enforced: `max code size exceeded: code size 39959 limit 24576` | `eth_estimateGas` on a 40 KB deploy | Desk split into linked libraries |
| Elysium `eth_getLogs` range | — | 99801 | 50,000-block spans accepted | probe | Web and watcher scan in 49,000-block chunks |
| HyperCore market-data precompile | https://elysium.kinetiq.xyz/docs/hypercore-market-data | — | **Not available.** Docs: ships in an ArbOS upgrade about four weeks after mainnet | docs | Keeper-posted EIP-712 observations |
| ElysiumCoreWriter keeper lane | https://elysium.kinetiq.xyz/docs/trading-on-hypercore-from-elysium | — | **Not available** (same upgrade) | docs | Open-source keeper executes contract intents |
| Elysium testnet faucet | https://elysium.kinetiq.xyz/testnet-faucet | 99801 | Live, captcha and bot-protected (`{"error":"bot"}` for scripted calls) | POST `/api/faucet/testnet` | Manual claim by a person |
| Elysium USDC | listed in Building on Elysium: `0x7D29d8047B905000459c0E80c34a26CeedcB47b2` | 99801 | No verified testnet funding path found | — | Labelled test fee token `tFEE` |
| Hyperliquid testnet API | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint | `https://api.hyperliquid-testnet.xyz` | Live, CORS `*` on `/info` | info calls; signed actions return "User or API Wallet <our address> does not exist", which confirms our signature recovers to our key | — |
| Hyperliquid signing | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing | — | Our TS signer and our Python signer both match `hyperliquid-python-sdk` 0.24.0 byte for byte (order with `expiresAfter`, cancelByCloid, cancel, scheduleCancel, approveAgent, spotSend) | `keeper/test/signing.test.ts`, `watcher/tests` | — |
| API wallets (agents) | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets | testnet | Documented: 1 unnamed + 3 named per account, optional `valid_until` (≤ 180 days), pruned when replaced, expired or the account has no funds; nonces stored per signer (100 highest, window T−2 d…T+1 d) | docs | Named agents `staple-<id>`, `staple-guard-<id>`; fresh address per rotation |
| Agent revocation | Exchange endpoint: approving under an existing name replaces that agent | testnet | **To verify on testnet**: approving the zero address under the same name removes it | `ops.ts revoke-agent` + `extraAgents` | Owner can also trade or cancel directly with the master key |
| Agent permissions | Elysium docs and Hyperliquid docs | — | Agents can place and cancel orders and cannot withdraw. `agentSendAsset` exists but the destination must equal the source (self-transfer between DEXs) | docs | Disclosed |
| Scheduled cancel | Exchange endpoint "Schedule cancel (dead man's switch)" | testnet | Documented: time ≥ now + 5 s, max 10 triggers per day | — | Keeper renews 90 s ahead every 30 s |
| Order expiry `expiresAfter` | Exchange endpoint | testnet | Documented; stale actions cost 5× rate limit | — | 8 s placement expiry |
| Rate limits | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits | — | 1,200 weight/min/IP; address budget 10,000 + 1 per USDC traded; cancels get a higher cap | docs | Keeper reserves budget for cancels |
| Testnet USDC | https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/testnet-faucet | testnet | Faucet requires a prior mainnet deposit from the same address | docs | Manual funding by a person |
| Market | `spotMetaAndAssetCtxs` (testnet) | testnet | PURR/USDC: canonical, spot index 0, asset 10000, PURR szDecimals 0 / weiDecimals 5, USDC weiDecimals 8; $10 minimum order; book observed at ~99 bps spread with ~1 % ladder steps | info calls | — |

The testnet spot market chosen is PURR/USDC. No perpetual market is used.
