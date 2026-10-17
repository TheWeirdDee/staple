import type { Hex } from 'viem';
import { lotsToWire, parseScaled, pxToWire } from '@staple/reference';
import { HyperliquidClient, TransportError, type Fill, type L2Book } from './hl/client.js';

export interface MarketSpec {
  coin: string; // info-endpoint coin name, e.g. "PURR/USDC" or "@1204"
  asset: number; // order asset id (10000 + spot index)
  spotIndex: number;
  szDecimals: number;
  baseToken: string; // balance coin names
  quoteToken: string;
}

export type PlaceResult =
  | { kind: 'resting'; oid: bigint }
  | { kind: 'filled'; oid: bigint }
  | { kind: 'rejected'; error: string }
  | { kind: 'unknown'; error: string };

export type CancelResult = { kind: 'success' } | { kind: 'error'; error: string } | { kind: 'unknown'; error: string };

export type ExchangeOrderStatus =
  | { kind: 'missing' }
  | { kind: 'open'; oid: bigint; remainingLots: bigint }
  | { kind: 'filled'; oid: bigint }
  | { kind: 'cancelled'; oid: bigint; status: string }
  | { kind: 'rejected'; oid: bigint; status: string };

export interface NormFill {
  tid: bigint;
  oid: bigint;
  cloid?: bigint;
  isBuy: boolean;
  szLots: bigint;
  pxE8: bigint;
  feeE8: bigint;
  feeToken: string;
  timeMs: number;
  coin: string;
}

export interface ExchangePort {
  book(): Promise<L2Book>;
  markE8(): Promise<bigint>;
  balances(): Promise<{ baseE8: bigint; quoteE8: bigint }>;
  fillsSince(startMs: number): Promise<NormFill[]>;
  orderStatus(cloid: bigint): Promise<ExchangeOrderStatus>;
  openOrders(): Promise<{ oid: bigint; cloid?: bigint; isBuy: boolean; pxE8: bigint; remainingLots: bigint }[]>;
  placeAlo(cloid: bigint, isBuy: boolean, pxE8: bigint, lots: bigint, expiresAfterMs: number): Promise<PlaceResult>;
  cancel(cloid: bigint): Promise<CancelResult>;
  scheduleCancel(atMs?: number): Promise<{ ok: boolean; error?: string }>;
  rateLimit(): Promise<{ used: number; cap: number }>;
}

const hexCloid = (c: bigint) => `0x${c.toString(16).padStart(32, '0')}`;

/** Converts an exchange decimal to E8, rounding up any excess precision (conservative for fees). */
export function toE8Up(v: string): bigint {
  const [w, f = ''] = v.split('.');
  if (f.length <= 8) return parseScaled(v, 8);
  const head = parseScaled(`${w}.${f.slice(0, 8)}`, 8);
  return /[1-9]/.test(f.slice(8)) ? head + 1n : head;
}

export class HyperliquidExchange implements ExchangePort {
  private markCache?: { at: number; v: bigint };

  constructor(
    readonly hl: HyperliquidClient,
    readonly account: Hex, // owner's HyperCore account (queries); orders are signed by the agent in `hl`
    readonly m: MarketSpec,
    private markTtlMs = 30_000,
  ) {}

  book() {
    return this.hl.l2Book(this.m.coin);
  }

  async markE8() {
    const now = Date.now();
    if (this.markCache && now - this.markCache.at < this.markTtlMs) return this.markCache.v;
    const [, ctxs] = await this.hl.spotMetaAndAssetCtxs();
    const ctx = ctxs[this.m.spotIndex];
    const v = parseScaled(String(ctx.markPx), 8);
    this.markCache = { at: now, v };
    return v;
  }

  async balances() {
    const { balances } = await this.hl.spotBalances(this.account);
    const get = (coin: string) => balances.find((b) => b.coin === coin)?.total ?? '0';
    return { baseE8: toE8Up(get(this.m.baseToken)), quoteE8: toE8Up(get(this.m.quoteToken)) };
  }

  async fillsSince(startMs: number): Promise<NormFill[]> {
    const fills = await this.hl.userFillsByTime(this.account, startMs);
    return fills.map((f: Fill) => ({
      tid: BigInt(f.tid),
      oid: BigInt(f.oid),
      cloid: f.cloid ? BigInt(f.cloid) : undefined,
      isBuy: f.side === 'B',
      szLots: parseScaled(f.sz, this.m.szDecimals),
      pxE8: parseScaled(f.px, 8),
      feeE8: toE8Up(f.fee),
      feeToken: f.feeToken,
      timeMs: f.time,
      coin: f.coin,
    }));
  }

  async orderStatus(cloid: bigint): Promise<ExchangeOrderStatus> {
    const r = await this.hl.orderStatus(this.account, hexCloid(cloid));
    if (r.status !== 'order') return { kind: 'missing' };
    const { order, status } = r.order;
    const oid = BigInt(order.oid);
    if (status === 'open') return { kind: 'open', oid, remainingLots: parseScaled(order.sz, this.m.szDecimals) };
    if (status === 'filled') return { kind: 'filled', oid };
    if (status.endsWith('Rejected') || status === 'rejected') return { kind: 'rejected', oid, status };
    return { kind: 'cancelled', oid, status };
  }

  async openOrders() {
    const oo = await this.hl.openOrders(this.account);
    return oo
      .filter((o) => o.coin === this.m.coin)
      .map((o) => ({
        oid: BigInt(o.oid),
        cloid: o.cloid ? BigInt(o.cloid) : undefined,
        isBuy: o.side === 'B',
        pxE8: parseScaled(o.limitPx, 8),
        remainingLots: parseScaled(o.sz, this.m.szDecimals),
      }));
  }

  async placeAlo(cloid: bigint, isBuy: boolean, pxE8: bigint, lots: bigint, expiresAfterMs: number): Promise<PlaceResult> {
    try {
      const r = await this.hl.order(
        [
          {
            a: this.m.asset,
            b: isBuy,
            p: pxToWire(pxE8),
            s: lotsToWire(lots, this.m.szDecimals),
            r: false,
            t: { limit: { tif: 'Alo' } },
            c: hexCloid(cloid),
          },
        ],
        expiresAfterMs,
      );
      if (r?.status !== 'ok') return { kind: 'unknown', error: `request error: ${JSON.stringify(r?.response ?? r)}` };
      const st = r.response?.data?.statuses?.[0];
      if (st?.resting) return { kind: 'resting', oid: BigInt(st.resting.oid) };
      if (st?.filled) return { kind: 'filled', oid: BigInt(st.filled.oid) };
      if (st?.error) return { kind: 'rejected', error: String(st.error) };
      return { kind: 'unknown', error: `unrecognised status: ${JSON.stringify(st)}` };
    } catch (e) {
      if (e instanceof TransportError) return { kind: 'unknown', error: e.message };
      throw e;
    }
  }

  async cancel(cloid: bigint): Promise<CancelResult> {
    try {
      const r = await this.hl.cancelByCloid([{ asset: this.m.asset, cloid: hexCloid(cloid) }]);
      if (r?.status !== 'ok') return { kind: 'error', error: JSON.stringify(r?.response ?? r) };
      const st = r.response?.data?.statuses?.[0];
      if (st === 'success') return { kind: 'success' };
      return { kind: 'error', error: JSON.stringify(st) };
    } catch (e) {
      if (e instanceof TransportError) return { kind: 'unknown', error: e.message };
      throw e;
    }
  }

  async scheduleCancel(atMs?: number) {
    try {
      const r = await this.hl.scheduleCancel(atMs);
      return r?.status === 'ok' ? { ok: true } : { ok: false, error: JSON.stringify(r?.response ?? r) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async rateLimit() {
    const r = await this.hl.userRateLimit(this.account);
    return { used: r.nRequestsUsed, cap: r.nRequestsCap };
  }
}
