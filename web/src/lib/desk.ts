import { createPublicClient, http, parseEventLogs, type Hex, type Log } from 'viem';
import { MandateRegistryAbi, StapleDeskAbi } from '@staple/reference/abi';
import { elysiumTestnet, HAS_MULTICALL, type Deployment } from './config';

// cacheTime 0: history loads must read the true head, not a block number cached by an earlier page.
// The public Elysium RPC rate-limits per call, so contract reads issued together go out as one Multicall3 call.
export const pub = createPublicClient({
  chain: elysiumTestnet,
  transport: http(undefined, { timeout: 20_000, retryCount: 2 }),
  batch: { multicall: HAS_MULTICALL },
  cacheTime: 0,
});

export const MANDATE_STATES = [
  'DRAFT',
  'ACTIVE',
  'PAUSING',
  'PAUSED',
  'TRIPPED',
  'REVOKING',
  'REVOKED',
  'EXPIRING',
  'EXPIRED',
  'RECONCILIATION_REQUIRED',
] as const;
export type MandateStateName = (typeof MANDATE_STATES)[number];
export const HALTS = ['NONE', 'STALE', 'VOLATILITY', 'FEES', 'WATCHER', 'UNRECONCILED', 'VERSION_SWITCH'] as const;
export const ORDER_STATES = [
  'NONE',
  'INTENT_EMITTED',
  'SUBMISSION_UNKNOWN',
  'ACKNOWLEDGED',
  'RESTING',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELLED',
  'REJECTED',
] as const;
export const OUTCOME_KINDS = ['NONE', 'ACK_RESTING', 'SUBMISSION_UNKNOWN', 'REJECTED', 'FILL', 'CANCEL_CONFIRMED', 'CANCEL_REJECTED'];

export const REASONS: Record<number, { code: string; text: string }> = {
  1: { code: 'QUOTED', text: 'Quoted the policy ladder around the reference price' },
  2: { code: 'HEALTHY_STAY_OUT', text: 'External liquidity already met the policy, so the mandate stayed out' },
  3: { code: 'HEALTHY_JOIN', text: 'External liquidity met the policy; joined without improving the best price' },
  4: { code: 'STALE_REFERENCE', text: 'Reference data was too old: quoting stopped and cancellations were requested' },
  5: { code: 'DEVIATION', text: 'Book mid disagreed with the independent mark: quoting stopped' },
  6: { code: 'VOLATILITY', text: 'Price moved more than the volatility threshold: quotes pulled' },
  7: { code: 'LOSS_TRIGGER', text: 'Measured loss reached the loss trigger: shutdown requested' },
  8: { code: 'FEES_EXHAUSTED', text: 'Prepaid service fees ran out: no new placements (cancels still work)' },
  9: { code: 'UNRECONCILED_BALANCE', text: 'Account balances were not explained by reported fills' },
  10: { code: 'MISSING_OUTCOME', text: 'An order outcome stayed unknown past the reconciliation timeout' },
  11: { code: 'WATCHER_STALE', text: 'The independent watcher has not checked in recently: quoting fails closed' },
  12: { code: 'EXPIRY', text: 'The mandate reached its expiry' },
  13: { code: 'OWNER_PAUSE', text: 'The owner paused the mandate' },
  14: { code: 'OWNER_REVOKE', text: 'The owner started cancel-all-and-revoke' },
  15: { code: 'REQUOTE', text: 'An order drifted beyond the requote threshold and was replaced' },
  16: { code: 'MISMATCH', text: 'Exchange activity did not match any intent' },
  17: { code: 'VERSION_SWITCH', text: 'A new policy version is due; old orders are being cancelled first' },
  18: { code: 'NO_BOOK', text: 'One side of the external book was empty' },
  19: { code: 'WAITING_RECONCILE', text: 'Waiting for fills or confirmations to reconcile before quoting' },
  20: { code: 'CANCEL_RETRY', text: 'A cancellation was not confirmed in time and was requested again' },
};

/**
 * Reason shown for a Decision event. A quoting decision that placed nothing is ambiguous from the event alone:
 * either the existing orders still match the ladder, or no order fits the account balances and policy limits.
 * Pass `liveOrders` when the current order count is known (the latest decision) to resolve it.
 */
export function decisionReason(args: { reason: number | bigint; placed: number | bigint }, liveOrders?: number) {
  const n = Number(args.reason);
  if ((n === 1 || n === 3) && Number(args.placed) === 0) {
    if (liveOrders === 0) {
      return { code: `${REASONS[n].code} · NOTHING FITS`, text: 'The ladder was computed, but no order fits the account balances and policy limits, so nothing is quoted' };
    }
    if (liveOrders === undefined) {
      return { code: REASONS[n].code, text: 'Ladder computed; no new order (existing orders still match, or nothing fits the balances and limits)' };
    }
  }
  return REASONS[n] ?? { code: `#${n}`, text: '' };
}

const read = <T,>(address: Hex, abi: any, functionName: string, args: unknown[]) =>
  pub.readContract({ address, abi, functionName, args } as any) as Promise<T>;

export interface Identity {
  owner: Hex;
  operator: Hex;
  guardian: Hex;
  hlAccount: Hex;
  createdAt: bigint;
  latestVersion: number;
  pendingVersion: number;
  pendingEffectiveAt: bigint;
}

export interface PolicyView {
  market: { asset: number; szDecimals: number; isSpot: boolean; minNotionalE8: bigint };
  quotes: { spreadBps: number; levels: number; levelSpacingBps: number; sizeLots: bigint; skewBps: number; requoteBps: number; bookRule: number };
  exposure: { baselineBaseE8: bigint; minBaseE8: bigint; maxBaseE8: bigint; quoteBudgetE8: bigint; maxOutstandingNotionalE8: bigint; feeAllowanceBps: number };
  risk: {
    lossTriggerQuoteE8: bigint;
    volBps: number;
    volWindowSec: number;
    calmSec: number;
    maxRefAgeMs: number;
    maxDeviationBps: number;
    reconTimeoutSec: number;
    cancelTimeoutSec: number;
    watcherTimeoutSec: number;
  };
  fees: { feeBps: number; spendCap: bigint };
  expiry: bigint;
}

export interface OrderView {
  cloid: bigint;
  version: number;
  isBuy: boolean;
  state: (typeof ORDER_STATES)[number];
  pxE8: bigint;
  szLots: bigint;
  filledLots: bigint;
  oid: bigint;
  emittedAt: bigint;
  cancelRequestedAt: bigint;
  level: number;
}

export interface MandateView {
  id: bigint;
  identity: Identity;
  policy: PolicyView;
  activeVersion: number;
  runtime: any;
  state: MandateStateName;
  halt: (typeof HALTS)[number];
  accounting: any;
  fees: { balance: bigint; spent: bigint; owed: bigint };
  reservations: { buyLots: bigint; sellLots: bigint; buyQuoteE8: bigint; notionalE8: bigint; pendingCount: bigint };
  orders: OrderView[];
  block: bigint;
  chainTime: bigint;
}

export async function readMandate(dep: Deployment, id: bigint): Promise<MandateView> {
  const [identity, activeVersion, runtime, accounting, fees, reservations, cloids, block] = await Promise.all([
    read<Identity>(dep.registry, MandateRegistryAbi, 'identity', [id]),
    read<number>(dep.desk, StapleDeskAbi, 'activeVersion', [id]),
    read<any>(dep.desk, StapleDeskAbi, 'runtime', [id]),
    read<any>(dep.desk, StapleDeskAbi, 'getAccounting', [id]),
    read<any>(dep.registry, MandateRegistryAbi, 'getFees', [id]),
    read<any>(dep.desk, StapleDeskAbi, 'reservations', [id]),
    read<bigint[]>(dep.desk, StapleDeskAbi, 'liveCloids', [id]),
    pub.getBlock(),
  ]);
  if (identity.owner === '0x0000000000000000000000000000000000000000') throw new NotFound(`Mandate ${id} does not exist`);
  const [policy, ...orders] = await Promise.all([
    policyVersion(dep, id, Number(activeVersion)),
    ...cloids.map((c) => read<any>(dep.desk, StapleDeskAbi, 'getOrder', [c])),
  ]);
  return {
    id,
    identity,
    policy,
    activeVersion: Number(activeVersion),
    runtime,
    state: MANDATE_STATES[runtime.state],
    halt: HALTS[runtime.halt],
    accounting,
    fees,
    reservations,
    orders: orders.map((o, i) => ({ ...o, cloid: cloids[i], state: ORDER_STATES[o.state], version: Number(o.version), level: Number(o.level) })),
    block: block.number,
    chainTime: block.timestamp,
  };
}

export class NotFound extends Error {}

// A published policy version never changes, so each one is read once per page load.
const policies = new Map<string, Promise<PolicyView>>();
function policyVersion(dep: Deployment, id: bigint, version: number): Promise<PolicyView> {
  const k = `${dep.registry}:${id}:${version}`;
  let p = policies.get(k);
  if (!p) {
    p = read<PolicyView>(dep.registry, MandateRegistryAbi, 'getPolicy', [id, version]);
    p.catch(() => policies.delete(k));
    policies.set(k, p);
  }
  return p;
}

export async function readPolicy(dep: Deployment, id: bigint, version: number) {
  const [p, created, effective] = await Promise.all([
    read<PolicyView>(dep.registry, MandateRegistryAbi, 'getPolicy', [id, version]),
    read<bigint>(dep.registry, MandateRegistryAbi, 'versionCreatedAt', [id, version]),
    read<bigint>(dep.registry, MandateRegistryAbi, 'versionEffectiveAt', [id, version]),
  ]);
  return { policy: p, createdAt: created, effectiveAt: effective };
}

export type DeskEvent = {
  name: string;
  args: any;
  block: bigint;
  tx: Hex;
  logIndex: number;
  time?: bigint;
};

const CHUNK = 49_000n;
const cache = new Map<string, { to: bigint; events: DeskEvent[] }>();

/** Incrementally loads desk + registry events for one mandate in bounded block ranges. */
export async function loadEvents(dep: Deployment, id: bigint, onProgress?: (pct: number) => void): Promise<DeskEvent[]> {
  const key = `${dep.desk}:${id}`;
  const head = await pub.getBlockNumber();
  const entry = cache.get(key) ?? { to: BigInt(dep.deployBlock) - 1n, events: [] };
  const start = entry.to + 1n;
  for (let from = start; from <= head; from += CHUNK) {
    const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
    const [deskLogs, regLogs] = await Promise.all([
      pub.getLogs({ address: dep.desk, fromBlock: from, toBlock: to }),
      pub.getLogs({ address: dep.registry, fromBlock: from, toBlock: to }),
    ]);
    const parsed = [
      ...parseEventLogs({ abi: StapleDeskAbi as any, logs: deskLogs as Log[] }),
      ...parseEventLogs({ abi: MandateRegistryAbi as any, logs: regLogs as Log[] }),
    ] as any[];
    for (const l of parsed) {
      if (l.args?.mandateId !== undefined && l.args.mandateId !== id) continue;
      if (l.eventName === 'Heartbeat') continue; // shown as watcher health, not history
      entry.events.push({ name: l.eventName, args: l.args, block: l.blockNumber, tx: l.transactionHash, logIndex: l.logIndex });
    }
    entry.to = to;
    onProgress?.(Number(((to - start + 1n) * 100n) / (head - start + 1n || 1n)));
  }
  entry.events.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  cache.set(key, entry);
  return entry.events;
}

const blockTimes = new Map<bigint, bigint>();
export async function blockTime(n: bigint): Promise<bigint> {
  const c = blockTimes.get(n);
  if (c) return c;
  const b = await pub.getBlock({ blockNumber: n });
  blockTimes.set(n, b.timestamp);
  return b.timestamp;
}

export async function mandatesOf(dep: Deployment, owner: Hex): Promise<bigint[]> {
  const head = await pub.getBlockNumber();
  const ids: bigint[] = [];
  for (let from = BigInt(dep.deployBlock); from <= head; from += CHUNK) {
    const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
    const logs = await pub.getLogs({
      address: dep.registry,
      event: (MandateRegistryAbi as any).find((x: any) => x.type === 'event' && x.name === 'MandateCreated'),
      args: { owner },
      fromBlock: from,
      toBlock: to,
    } as any);
    for (const l of logs as any[]) ids.push(l.args.mandateId);
  }
  return ids;
}

export async function mandateCount(dep: Deployment): Promise<bigint> {
  return read<bigint>(dep.registry, MandateRegistryAbi, 'mandateCount', []);
}
