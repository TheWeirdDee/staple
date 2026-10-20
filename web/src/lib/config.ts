import { defineChain, type Hex } from 'viem';

// Local end-to-end tests point the app at a local node; production builds never set these.
const RPC = (import.meta.env.VITE_STAPLE_RPC as string | undefined) ?? 'https://testnet-rpc.elysium.kinetiq.xyz';
const CHAIN_ID = Number(import.meta.env.VITE_STAPLE_CHAIN_ID ?? 99801);
// Multicall3 is deployed on Elysium testnet at the canonical address; local test chains do not have it.
export const HAS_MULTICALL = CHAIN_ID === 99801;

export const elysiumTestnet = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 99801 ? 'Elysium Testnet' : `Local test chain ${CHAIN_ID}`,
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: 'Elysium Explorer', url: 'https://elysium.kinetiq.xyz/testnet-explorer' } },
  testnet: true,
  ...(HAS_MULTICALL ? { contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' as Hex } } } : {}),
});

export const HL_INFO = 'https://api.hyperliquid-testnet.xyz/info';
export const HL_APP = 'https://app.hyperliquid-testnet.xyz';
export const EXPLORER = 'https://elysium.kinetiq.xyz/testnet-explorer';
export const REPO = 'https://github.com/TheWeirdDee/staple';

export interface Deployment {
  chainId: number;
  feeToken: Hex;
  registry: Hex;
  desk: Hex;
  libraries: Record<string, Hex>;
  deployBlock: string;
  deployer: Hex;
  txs: Record<string, Hex>;
  /** Mandate shown on the public judge path. */
  featuredMandate?: string;
  market?: { coin: string; asset: number; spotIndex: number; szDecimals: number; baseToken: string; quoteToken: string };
  /** Hosted keeper's HyperCore agent address (the owner approves this on Hyperliquid). */
  keeperAgent?: Hex;
  /** Watcher's separately approved guard agent (emergency cancellation only). */
  guardAgent?: Hex;
  /** Hosted keeper reporter (signs observations/outcomes) and watcher guardian addresses on Elysium. */
  keeperOperator?: Hex;
  watcherGuardian?: Hex;
  watcherHealthUrl?: string;
  keeperHealthUrl?: string;
}

let cached: Promise<Deployment | null> | null = null;

/** Loads the published deployment record. Absent before the first testnet deployment. */
export function loadDeployment(): Promise<Deployment | null> {
  cached ??= fetch(import.meta.env.VITE_STAPLE_DEPLOYMENT_URL ?? `${import.meta.env.BASE_URL}deployment.json`, { cache: 'no-cache' })
    .then((r) => (r.ok ? (r.json() as Promise<Deployment>) : null))
    .catch(() => null);
  return cached;
}

export const explorerTx = (h: string) => `${EXPLORER}/transaction/${h}`;
export const explorerAddr = (a: string) => `${EXPLORER}/address/${a}`;
export const hlAccount = (a: string) => `${HL_APP}/explorer/address/${a}`;
