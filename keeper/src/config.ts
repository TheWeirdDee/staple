import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import type { Hex } from 'viem';
import { loadKeystore } from './keystore.js';
import type { MarketSpec } from './exchange.js';
import type { Network } from './hl/signing.js';

export interface RuntimeConfig {
  network: Network;
  rpcUrl: string;
  deploymentPath: string;
  mandateId: bigint;
  ownerAccount: Hex;
  market: MarketSpec;
  stateDir: string;
  tickMs: number;
  operatorKey: Hex;
  agentKey: Hex;
  healthPort: number;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
}

/**
 * Keys come from an encrypted keystore (STAPLE_KEYSTORE + STAPLE_KEYSTORE_PASSPHRASE) or, for local
 * development only, from STAPLE_OPERATOR_KEY / STAPLE_AGENT_KEY. They are never printed.
 */
export function loadConfig(): RuntimeConfig {
  const network = (process.env.STAPLE_NETWORK ?? 'testnet') as Network;
  if (network !== 'testnet') throw new Error('this build only runs against testnet (STAPLE_NETWORK=testnet)');
  let operatorKey = process.env.STAPLE_OPERATOR_KEY as Hex | undefined;
  let agentKey = process.env.STAPLE_AGENT_KEY as Hex | undefined;
  const ks = process.env.STAPLE_KEYSTORE;
  if (ks && existsSync(ks)) {
    const keys = loadKeystore(ks, req('STAPLE_KEYSTORE_PASSPHRASE'));
    operatorKey = keys.operator;
    agentKey = keys.agent;
  }
  if (!operatorKey || !agentKey) throw new Error('operator and agent keys are required (keystore or env)');
  const marketPath = process.env.STAPLE_MARKET ?? fileURLToPath(new URL('../../runs/market-purr-usdc-testnet.json', import.meta.url));
  const market = JSON.parse(readFileSync(marketPath, 'utf8')) as MarketSpec;
  return {
    network,
    rpcUrl: process.env.STAPLE_ELYSIUM_RPC ?? 'https://testnet-rpc.elysium.kinetiq.xyz',
    deploymentPath: req('STAPLE_DEPLOYMENT'),
    mandateId: BigInt(req('STAPLE_MANDATE_ID')),
    ownerAccount: req('STAPLE_OWNER_ACCOUNT') as Hex,
    market,
    stateDir: process.env.STAPLE_STATE_DIR ?? 'state',
    tickMs: Number(process.env.STAPLE_TICK_MS ?? 5000),
    operatorKey,
    agentKey,
    healthPort: Number(process.env.STAPLE_HEALTH_PORT ?? 8787),
  };
}
