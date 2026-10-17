/**
 * Campaign controller: alternates equal-length mandate-on and mandate-off blocks in an ABBA order (on, off,
 * off, on, …) derived from a fixed start time, so a restart resumes the same schedule. During on-blocks a
 * clearly labelled controlled taker occasionally lifts one lot of a Staple quote; those fills are reported
 * separately from any other activity and never presented as organic demand.
 *
 * Env: STAPLE_CAMPAIGN_ID, STAPLE_CAMPAIGN_START (unix s), STAPLE_BLOCK_MIN, STAPLE_CAMPAIGN_END (unix s),
 *      STAPLE_TAKER_EVERY_MIN, STAPLE_DEPLOYMENT, keys via keystore (owner, taker).
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { StapleDeskAbi } from '@staple/reference/abi';
import { lotsToWire, pxToWire } from '@staple/reference';
import { elysiumTestnet } from './chain.js';
import { HyperliquidClient } from './hl/client.js';
import { loadKeystore } from './keystore.js';
import { MandateState } from './types.js';

const PATTERN: ('on' | 'off')[] = ['on', 'off', 'off', 'on'];

export function armAt(nowSec: number, startSec: number, blockSec: number): { idx: number; arm: 'on' | 'off'; endsAt: number } {
  const idx = Math.floor((nowSec - startSec) / blockSec);
  return { idx, arm: PATTERN[((idx % 4) + 4) % 4], endsAt: startSec + (idx + 1) * blockSec };
}

async function main() {
  const env = process.env;
  const keys = loadKeystore(env.STAPLE_KEYSTORE!, env.STAPLE_KEYSTORE_PASSPHRASE!);
  const dep = JSON.parse(readFileSync(env.STAPLE_DEPLOYMENT!, 'utf8'));
  const id = BigInt(dep.featuredMandate);
  const start = Number(env.STAPLE_CAMPAIGN_START);
  const end = Number(env.STAPLE_CAMPAIGN_END ?? start + 86_400);
  const blockSec = Number(env.STAPLE_BLOCK_MIN ?? '30') * 60;
  const takerEvery = Number(env.STAPLE_TAKER_EVERY_MIN ?? '15') * 60_000;
  const dir = join(env.STAPLE_STATE_DIR ?? 'state', `campaign-${env.STAPLE_CAMPAIGN_ID}`);
  mkdirSync(dir, { recursive: true });
  const log = (file: string, d: Record<string, unknown>) =>
    appendFileSync(join(dir, file), JSON.stringify({ t: Date.now(), ...d }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n');

  const transport = http(env.STAPLE_ELYSIUM_RPC ?? 'https://testnet-rpc.elysium.kinetiq.xyz', { timeout: 30_000, retryCount: 3 });
  const pub = createPublicClient({ chain: elysiumTestnet, transport });
  const owner = createWalletClient({ chain: elysiumTestnet, transport, account: privateKeyToAccount(keys.owner) });
  const taker = new HyperliquidClient('testnet', keys.taker);
  const ownerAddr = owner.account.address;
  let lastTake = 0;
  let side = true;

  const state = async () => MandateState[((await pub.readContract({ address: dep.desk, abi: StapleDeskAbi, functionName: 'runtime', args: [id] } as any)) as any).state];
  const call = async (fn: 'activate' | 'pause') => {
    const hash = await owner.writeContract({ address: dep.desk as Hex, abi: StapleDeskAbi, functionName: fn, args: [id], chain: elysiumTestnet, account: owner.account } as any);
    await pub.waitForTransactionReceipt({ hash });
    return hash;
  };

  log('schedule.jsonl', { event: 'controller_start', start, end, blockSec, pattern: PATTERN });
  for (;;) {
    const now = Math.floor(Date.now() / 1000);
    if (now >= end) {
      const s = await state();
      if (s === 'ACTIVE') log('schedule.jsonl', { event: 'campaign_end_pause', tx: await call('pause') });
      log('schedule.jsonl', { event: 'campaign_end' });
      return;
    }
    const { idx, arm, endsAt } = armAt(now, start, blockSec);
    try {
      const s = await state();
      if (arm === 'on' && s === 'PAUSED') log('schedule.jsonl', { event: 'block_on', idx, endsAt, tx: await call('activate') });
      else if (arm === 'off' && s === 'ACTIVE') log('schedule.jsonl', { event: 'block_off', idx, endsAt, tx: await call('pause') });
      else if (!['ACTIVE', 'PAUSED', 'PAUSING'].includes(s)) log('schedule.jsonl', { event: 'unexpected_state', idx, arm, state: s });

      // Labelled controlled taker: lift 1 lot of a resting Staple quote, alternating sides.
      if (arm === 'on' && s === 'ACTIVE' && Date.now() - lastTake > takerEvery && now < endsAt - 120) {
        const open = (await taker.openOrders(ownerAddr)).filter((o) => o.coin === dep.market.coin && o.cloid);
        const target = open
          .filter((o) => (side ? o.side === 'A' : o.side === 'B'))
          .sort((a, b) => (side ? Number(a.limitPx) - Number(b.limitPx) : Number(b.limitPx) - Number(a.limitPx)))[0];
        if (target) {
          const px = BigInt(Math.round(Number(target.limitPx) * 1e8));
          const r = await taker.order([{ a: dep.market.asset, b: side, p: pxToWire(px), s: lotsToWire(1n, dep.market.szDecimals), r: false, t: { limit: { tif: 'Ioc' } } }]);
          log('taker.jsonl', { label: 'CONTROLLED_TAKER', side: side ? 'buy' : 'sell', targetOid: target.oid, targetCloid: target.cloid, px: target.limitPx, response: r });
          lastTake = Date.now();
          side = !side;
        }
      }
    } catch (e) {
      log('schedule.jsonl', { event: 'error', error: (e as Error).message.slice(0, 300) });
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

if (process.argv[1]?.endsWith('campaign.ts')) main();
