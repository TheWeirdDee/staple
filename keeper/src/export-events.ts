/**
 * Exports every desk and registry event for one mandate from the testnet deployment, with decoded reason, state
 * and halt names, so a run's on-chain record can be committed and checked against the explorer.
 *
 *   tsx src/export-events.ts <mandateId> <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http, parseEventLogs, type Hex, type Log } from 'viem';
import { MandateRegistryAbi, StapleDeskAbi } from '@staple/reference/abi';
import { elysiumTestnet } from './chain.js';
import { Halt, MandateState } from './types.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const REASONS = [
  '', 'QUOTED', 'HEALTHY_STAY_OUT', 'HEALTHY_JOIN', 'STALE_REFERENCE', 'DEVIATION', 'VOLATILITY', 'LOSS_TRIGGER',
  'FEES_EXHAUSTED', 'UNRECONCILED_BALANCE', 'MISSING_OUTCOME', 'WATCHER_STALE', 'EXPIRY', 'OWNER_PAUSE',
  'OWNER_REVOKE', 'REQUOTE', 'MISMATCH', 'VERSION_SWITCH', 'NO_BOOK', 'WAITING_RECONCILE', 'CANCEL_RETRY',
];
const CHUNK = 49_000n; // the Elysium RPC caps eth_getLogs at 50k blocks

async function main() {
  const [idArg, out] = process.argv.slice(2);
  if (!idArg || !out) throw new Error('usage: export-events.ts <mandateId> <out.json>');
  const id = BigInt(idArg);
  const dep = JSON.parse(readFileSync(join(ROOT, 'runs', 'deployment-testnet.json'), 'utf8'));
  const pub = createPublicClient({ chain: elysiumTestnet, transport: http(process.env.STAPLE_ELYSIUM_RPC ?? 'https://testnet-rpc.elysium.kinetiq.xyz', { retryCount: 3 }) });
  const head = await pub.getBlockNumber();
  const events: Record<string, unknown>[] = [];
  const times = new Map<bigint, bigint>();
  for (let from = BigInt(dep.deployBlock); from <= head; from += CHUNK) {
    const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
    const [deskLogs, regLogs] = await Promise.all([
      pub.getLogs({ address: dep.desk as Hex, fromBlock: from, toBlock: to }),
      pub.getLogs({ address: dep.registry as Hex, fromBlock: from, toBlock: to }),
    ]);
    const parsed = [
      ...parseEventLogs({ abi: StapleDeskAbi as any, logs: deskLogs as Log[] }),
      ...parseEventLogs({ abi: MandateRegistryAbi as any, logs: regLogs as Log[] }),
    ] as any[];
    for (const l of parsed) {
      if (l.args?.mandateId !== id) continue;
      if (!times.has(l.blockNumber)) times.set(l.blockNumber, (await pub.getBlock({ blockNumber: l.blockNumber })).timestamp);
      const args: Record<string, unknown> = { ...l.args };
      for (const k of ['reason', 'reasonCode']) if (typeof args[k] === 'number') args[`${k}Name`] = REASONS[args[k] as number];
      if (l.eventName === 'StateChanged') Object.assign(args, { fromName: MandateState[args.from as number], toName: MandateState[args.to as number] });
      if (l.eventName === 'HaltChanged') args.haltName = Halt[args.halt as number];
      events.push({ event: l.eventName, block: l.blockNumber, time: new Date(Number(times.get(l.blockNumber)) * 1000).toISOString(), tx: l.transactionHash, logIndex: l.logIndex, args });
    }
  }
  events.sort((a: any, b: any) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  const doc = { mandateId: id, chainId: elysiumTestnet.id, desk: dep.desk, registry: dep.registry, exportedAt: new Date().toISOString(), headBlock: head, events };
  writeFileSync(out, JSON.stringify(doc, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  console.log(`wrote ${events.length} events for mandate ${id} to ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
