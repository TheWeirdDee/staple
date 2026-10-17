/**
 * TEST DOUBLE ONLY. An in-memory stand-in for HyperCore used to inject failures offline (lost responses,
 * delayed or rejected cancels, partial fills during cancellation, duplicate fill delivery, exchange-side
 * scheduled cancels, unrelated account activity). It is never used as evidence of exchange integration.
 */
import type { CancelResult, ExchangeOrderStatus, ExchangePort, NormFill, PlaceResult } from '../src/exchange.js';
import type { L2Book } from '../src/hl/client.js';

interface FakeOrder {
  oid: bigint;
  cloid: bigint;
  isBuy: boolean;
  pxE8: bigint;
  lots: bigint;
  filled: bigint;
  status: 'open' | 'filled' | 'canceled' | 'scheduledCancel';
}

export class FakeExchange implements ExchangePort {
  now = Date.now();
  bookTime = Date.now();
  extBids: [bigint, bigint][] = [[453420000n, 100000n]];
  extAsks: [bigint, bigint][] = [[457950000n, 77692n]];
  mark = 455685000n;
  baseE8 = 30_00000000n;
  quoteE8 = 300_00000000n;
  orders = new Map<string, FakeOrder>();
  fills: NormFill[] = [];
  private nextOid = 1000n;
  private nextTid = 1n;
  scheduledAt?: number;
  placeCalls = 0;
  cancelCalls = 0;

  // fault injection
  dropNextPlaceResponse: 'accepted' | 'not_accepted' | null = null;
  delayCancels = 0; // number of cancel calls that report success but leave the order open
  rejectNextCancel = false;
  duplicateFills = false;

  private tickClock() {
    this.bookTime = Math.max(this.bookTime + 1, this.now);
  }

  async book(): Promise<L2Book> {
    this.tickClock();
    const lv = (rows: [bigint, bigint][], mine: FakeOrder[]) => {
      const m = new Map<string, bigint>();
      for (const [p, s] of rows) m.set(p.toString(), (m.get(p.toString()) ?? 0n) + s);
      for (const o of mine) m.set(o.pxE8.toString(), (m.get(o.pxE8.toString()) ?? 0n) + (o.lots - o.filled));
      return [...m.entries()].map(([p, s]) => ({ px: (Number(p) / 1e8).toString(), sz: s.toString(), n: 1 }));
    };
    const open = [...this.orders.values()].filter((o) => o.status === 'open');
    const bids = lv(this.extBids, open.filter((o) => o.isBuy)).sort((a, b) => Number(b.px) - Number(a.px));
    const asks = lv(this.extAsks, open.filter((o) => !o.isBuy)).sort((a, b) => Number(a.px) - Number(b.px));
    return { coin: 'PURR/USDC', time: this.bookTime, levels: [bids, asks] };
  }
  async markE8() {
    return this.mark;
  }
  async balances() {
    this.fireSchedule();
    return { baseE8: this.baseE8, quoteE8: this.quoteE8 };
  }
  async fillsSince(startMs: number) {
    // The real /info endpoint rejects a negative or fractional startTime (HTTP 422).
    if (!Number.isInteger(startMs) || startMs < 0) throw new Error(`/info HTTP 422: bad startTime ${startMs}`);
    const f = this.fills.filter((x) => x.timeMs >= startMs);
    return this.duplicateFills ? [...f, ...f] : f;
  }
  async orderStatus(cloid: bigint): Promise<ExchangeOrderStatus> {
    this.fireSchedule();
    const o = this.orders.get(cloid.toString());
    if (!o) return { kind: 'missing' };
    if (o.status === 'open') return { kind: 'open', oid: o.oid, remainingLots: o.lots - o.filled };
    if (o.status === 'filled') return { kind: 'filled', oid: o.oid };
    return { kind: 'cancelled', oid: o.oid, status: o.status };
  }
  async openOrders() {
    this.fireSchedule();
    return [...this.orders.values()]
      .filter((o) => o.status === 'open')
      .map((o) => ({ oid: o.oid, cloid: o.cloid, isBuy: o.isBuy, pxE8: o.pxE8, remainingLots: o.lots - o.filled }));
  }
  async placeAlo(cloid: bigint, isBuy: boolean, pxE8: bigint, lots: bigint, expiresAfterMs: number): Promise<PlaceResult> {
    this.placeCalls++;
    if (this.now > expiresAfterMs) return { kind: 'rejected', error: 'expired' };
    if (this.orders.has(cloid.toString())) return { kind: 'rejected', error: 'duplicate cloid' };
    const drop = this.dropNextPlaceResponse;
    this.dropNextPlaceResponse = null;
    if (drop === 'not_accepted') return { kind: 'unknown', error: 'simulated timeout before acceptance' };
    const o: FakeOrder = { oid: this.nextOid++, cloid, isBuy, pxE8, lots, filled: 0n, status: 'open' };
    this.orders.set(cloid.toString(), o);
    if (drop === 'accepted') return { kind: 'unknown', error: 'simulated timeout after acceptance' };
    return { kind: 'resting', oid: o.oid };
  }
  async cancel(cloid: bigint): Promise<CancelResult> {
    this.cancelCalls++;
    const o = this.orders.get(cloid.toString());
    if (!o || o.status !== 'open') return { kind: 'error', error: 'Order was never placed, already canceled, or filled.' };
    if (this.rejectNextCancel) {
      this.rejectNextCancel = false;
      return { kind: 'error', error: 'simulated cancel rejection' };
    }
    if (this.delayCancels > 0) {
      this.delayCancels--;
      return { kind: 'success' };
    }
    o.status = 'canceled';
    return { kind: 'success' };
  }
  /** Completes cancels that were acknowledged but delayed. */
  flushDelayedCancels(cloids: bigint[]) {
    for (const c of cloids) {
      const o = this.orders.get(c.toString());
      if (o && o.status === 'open') o.status = 'canceled';
    }
  }
  async scheduleCancel(atMs?: number) {
    this.scheduledAt = atMs;
    return { ok: true };
  }
  private fireSchedule() {
    if (this.scheduledAt !== undefined && this.now >= this.scheduledAt) {
      for (const o of this.orders.values()) if (o.status === 'open') o.status = 'scheduledCancel';
      this.scheduledAt = undefined;
    }
  }
  async rateLimit() {
    return { used: 100, cap: 10_000 };
  }

  /** A labelled controlled taker lifting one of our orders. Fees: base on buys, quote on sells (spot). */
  takerHit(cloid: bigint, lots: bigint, feeE8 = 40000n) {
    const o = this.orders.get(cloid.toString());
    if (!o || o.status !== 'open') throw new Error('not open');
    const take = lots > o.lots - o.filled ? o.lots - o.filled : lots;
    o.filled += take;
    if (o.filled === o.lots) o.status = 'filled';
    const baseE8 = take * 100000000n;
    const notional = (o.pxE8 * baseE8) / 100000000n;
    if (o.isBuy) {
      this.baseE8 += baseE8 - feeE8;
      this.quoteE8 -= notional;
    } else {
      this.baseE8 -= baseE8;
      this.quoteE8 += notional - feeE8;
    }
    const f: NormFill = {
      tid: this.nextTid++,
      oid: o.oid,
      cloid,
      isBuy: o.isBuy,
      szLots: take,
      pxE8: o.pxE8,
      feeE8,
      feeToken: o.isBuy ? 'PURR' : 'USDC',
      timeMs: this.now,
      coin: 'PURR/USDC',
    };
    this.fills.push(f);
    return f;
  }
}
