import type { DeskPort } from './chain.js';
import type { ExchangePort, MarketSpec, NormFill, ExchangeOrderStatus } from './exchange.js';
import { parseScaled } from '@staple/reference';
import type { EventLog, Wal } from './wal.js';
import { OutcomeKind, terminal, type ChainOrder, type Observation, type Outcome, type Runtime } from './types.js';

export interface KeeperConfig {
  mandateId: bigint;
  market: MarketSpec;
  /** Every placement carries expiresAfter = now + this, so an unknown outcome becomes decidable afterwards. */
  expiresAfterMs: number;
  /** Extra wait after expiresAfter before trusting "unknownOid". */
  unknownGraceMs: number;
  /** Exchange-side dead man's switch lead time and renewal cadence. */
  scheduleCancelLeadMs: number;
  scheduleCancelEveryMs: number;
  fillLookbackMs: number;
  /** Stop submitting new placements below this many remaining address-based requests (cancels keep working). */
  minRequestBudget: number;
  rateCheckEveryMs: number;
  /** Sweep the exchange's open orders to catch removals without a cancel intent (dead man's switch, owner). */
  sweepEveryMs: number;
}

export const defaultKeeperConfig = (mandateId: bigint, market: MarketSpec): KeeperConfig => ({
  mandateId,
  market,
  expiresAfterMs: 8_000,
  unknownGraceMs: 3_000,
  scheduleCancelLeadMs: 90_000,
  scheduleCancelEveryMs: 30_000,
  fillLookbackMs: 120_000,
  minRequestBudget: 400,
  rateCheckEveryMs: 300_000,
  sweepEveryMs: 15_000,
});

const key = (c: bigint) => c.toString();

export interface StepReport {
  recovered: boolean;
  placed: number;
  cancelsSent: number;
  outcomes: number;
  ticked: boolean;
  skippedReason?: string;
}

export class Keeper {
  recovered = false;
  private reported = new Set<string>(); // fill tids reported (or confirmed seen on-chain)
  private budgetOk = true;
  private lastRateCheck = 0;
  private cancelResults = new Map<string, string>();
  private lastSweep = 0;

  constructor(
    readonly cfg: KeeperConfig,
    readonly desk: DeskPort,
    readonly ex: ExchangePort,
    readonly wal: Wal,
    readonly log: EventLog,
    readonly now: () => number = () => Date.now(),
  ) {}

  private get id() {
    return this.cfg.mandateId;
  }

  // -------------------------------------------------------------- recovery

  /**
   * Restart recovery: before any new exposure, reconcile every live intent against the exchange and ingest any
   * fills the chain has not seen. Returns false while an outcome is still undecidable.
   */
  async recover(): Promise<boolean> {
    const rt = await this.desk.runtime(this.id);
    const live = await this.desk.liveOrders(this.id);
    const outs: Outcome[] = [];
    let blocked = false;
    for (const o of live) {
      const sub = this.wal.state.submissions[key(o.cloid)];
      if (sub && this.now() < sub.expiresAfter + this.cfg.unknownGraceMs) {
        blocked = true; // a placement may still land: wait until it is decidable
        continue;
      }
      // Query even intents with no write-ahead record, in case the record itself was lost.
      const st = await this.ex.orderStatus(o.cloid);
      if (st.kind === 'missing' && !sub && o.state === 'INTENT_EMITTED') continue; // genuinely never sent
      outs.push(...this.statusOutcomes(o, st));
      if (st.kind !== 'missing' && !sub) {
        this.wal.state.submissions[key(o.cloid)] = { at: this.now(), expiresAfter: this.now(), result: 'recovered' };
      }
    }
    outs.push(...(await this.newFillOutcomes(rt, live, true)));
    await this.report(rt, this.ordered(outs));
    this.recovered = !blocked;
    this.log.write('recovery', { recovered: this.recovered, live: live.length, outcomes: outs.length });
    return this.recovered;
  }

  /** Maps a queried exchange status to outcomes. Fills are reported separately from the fill feed. */
  private statusOutcomes(o: ChainOrder, st: ExchangeOrderStatus): Outcome[] {
    const base = { cloid: o.cloid, fillId: 0n, szLots: 0n, pxE8: 0n, feeE8: 0n, timeMs: BigInt(this.now()) };
    switch (st.kind) {
      case 'missing':
        // Only a placement whose expiresAfter has passed is decidably never placed. A missing order the chain
        // believes is resting is an anomaly: leave it for reconciliation rather than guessing.
        if (o.state !== 'INTENT_EMITTED' && o.state !== 'SUBMISSION_UNKNOWN') {
          this.log.write('anomaly', { cloid: o.cloid, detail: 'exchange reports unknown order for a resting intent' });
          return [];
        }
        return [{ ...base, kind: OutcomeKind.REJECTED, oid: 0n }];
      case 'open':
        return o.state === 'RESTING' || o.state === 'PARTIALLY_FILLED' ? [] : [{ ...base, kind: OutcomeKind.ACK_RESTING, oid: st.oid }];
      case 'filled':
        return o.state === 'INTENT_EMITTED' || o.state === 'SUBMISSION_UNKNOWN'
          ? [{ ...base, kind: OutcomeKind.ACK_RESTING, oid: st.oid }]
          : [];
      case 'cancelled':
        return [{ ...base, kind: OutcomeKind.CANCEL_CONFIRMED, oid: st.oid }];
      case 'rejected':
        return [{ ...base, kind: OutcomeKind.REJECTED, oid: st.oid }];
    }
  }

  // ------------------------------------------------------------------ step

  async step(): Promise<StepReport> {
    const rep: StepReport = { recovered: this.recovered, placed: 0, cancelsSent: 0, outcomes: 0, ticked: false };
    if (!this.recovered && !(await this.recover())) {
      rep.skippedReason = 'recovery pending: waiting for an unknown placement to become decidable';
      return rep;
    }
    rep.recovered = true;
    await this.checkBudget();

    let rt = await this.desk.runtime(this.id);
    // A draft mandate has no orders and the desk rejects ticks for it, so wait for the owner to activate.
    if (rt.state === 'DRAFT') {
      rep.skippedReason = 'mandate is a draft: waiting for owner activation';
      return rep;
    }
    let live = await this.desk.liveOrders(this.id);
    const outs: Outcome[] = [];

    // 1. Resolve unknown placements by querying, never by blind retry.
    for (const o of live) {
      const sub = this.wal.state.submissions[key(o.cloid)];
      const unknown = o.state === 'SUBMISSION_UNKNOWN' || (o.state === 'INTENT_EMITTED' && sub?.result === 'unknown');
      if (!unknown || !sub) continue;
      if (this.now() < sub.expiresAfter + this.cfg.unknownGraceMs) continue;
      const st = await this.ex.orderStatus(o.cloid);
      this.log.write('unknown_resolved', { cloid: o.cloid, status: st.kind });
      outs.push(...this.statusOutcomes(o, st));
    }

    // 2. Execute placement intents exactly once (write-ahead record before sending).
    for (const o of live) {
      if (o.state !== 'INTENT_EMITTED' || o.cancelRequestedAt !== 0n) continue;
      if (this.wal.state.submissions[key(o.cloid)]) continue;
      const t0 = this.now();
      if (!this.budgetOk) {
        this.wal.state.submissions[key(o.cloid)] = { at: t0, expiresAfter: t0, result: 'skipped_budget' };
        this.wal.flush();
        outs.push(this.simple(o.cloid, OutcomeKind.REJECTED, 0n));
        this.log.write('place_skipped', { cloid: o.cloid, reason: 'request budget reserved for cancellation' });
        continue;
      }
      const expiresAfter = t0 + this.cfg.expiresAfterMs;
      this.wal.state.submissions[key(o.cloid)] = { at: t0, expiresAfter };
      this.wal.flush();
      const res = await this.ex.placeAlo(o.cloid, o.isBuy, o.pxE8, o.szLots - o.filledLots, expiresAfter);
      const t1 = this.now();
      this.wal.state.submissions[key(o.cloid)].result = res.kind;
      this.wal.flush();
      this.log.write('place', {
        cloid: o.cloid,
        isBuy: o.isBuy,
        pxE8: o.pxE8,
        szLots: o.szLots,
        level: o.level,
        result: res.kind,
        oid: 'oid' in res ? res.oid : undefined,
        error: 'error' in res ? res.error : undefined,
        sentAt: t0,
        ackAt: t1,
        emittedAtSec: o.emittedAt,
      });
      rep.placed++;
      if (res.kind === 'resting' || res.kind === 'filled') outs.push(this.simple(o.cloid, OutcomeKind.ACK_RESTING, res.oid));
      else if (res.kind === 'rejected') outs.push(this.simple(o.cloid, OutcomeKind.REJECTED, 0n));
      else outs.push(this.simple(o.cloid, OutcomeKind.SUBMISSION_UNKNOWN, 0n));
    }

    // 3. Execute cancel intents (including on-chain retries after the cancel timeout).
    for (const o of live) {
      if (o.cancelRequestedAt === 0n) continue;
      if (this.wal.state.cancelsSent[key(o.cloid)] === Number(o.cancelRequestedAt)) continue;
      const sub = this.wal.state.submissions[key(o.cloid)];
      if (o.state === 'INTENT_EMITTED' && !sub) {
        // Never sent to the exchange and never will be: terminal without exchange exposure.
        this.wal.state.submissions[key(o.cloid)] = { at: this.now(), expiresAfter: this.now(), result: 'withdrawn' };
        this.wal.state.cancelsSent[key(o.cloid)] = Number(o.cancelRequestedAt);
        outs.push(this.simple(o.cloid, OutcomeKind.REJECTED, 0n));
        continue;
      }
      if (o.state === 'SUBMISSION_UNKNOWN' || (o.state === 'INTENT_EMITTED' && sub?.result === 'unknown')) {
        continue; // resolve first; the cancel is retried by the contract after its timeout
      }
      const t0 = this.now();
      const r = await this.ex.cancel(o.cloid);
      this.wal.state.cancelsSent[key(o.cloid)] = Number(o.cancelRequestedAt);
      this.cancelResults.set(key(o.cloid), r.kind === 'success' ? 'success' : `${r.kind}: ${'error' in r ? r.error : ''}`);
      this.log.write('cancel', { cloid: o.cloid, oid: o.oid, result: r.kind, sentAt: t0, doneAt: this.now(), requestedAtSec: o.cancelRequestedAt });
      rep.cancelsSent++;
    }
    this.wal.flush();

    // 4. Fills (exactly once), then 5. confirmations of cancels the exchange has completed.
    outs.push(...(await this.newFillOutcomes(rt, live, false)));
    if (this.now() - this.lastSweep >= this.cfg.sweepEveryMs) {
      this.lastSweep = this.now();
      const open = new Set((await this.ex.openOrders()).map((x) => (x.cloid ?? -1n).toString()));
      for (const o of live) {
        const resting = o.state === 'RESTING' || o.state === 'PARTIALLY_FILLED' || o.state === 'ACKNOWLEDGED';
        if (!resting || open.has(key(o.cloid)) || this.wal.state.cancelsSent[key(o.cloid)]) continue;
        const st = await this.ex.orderStatus(o.cloid);
        this.log.write('sweep_removed', { cloid: o.cloid, status: st.kind, detail: 'status' in st ? st.status : undefined });
        if (st.kind === 'cancelled' || st.kind === 'rejected') outs.push(...this.statusOutcomes(o, st));
      }
    }
    for (const o of live) {
      if (!this.wal.state.cancelsSent[key(o.cloid)] || terminal(o.state)) continue;
      if (outs.some((x) => x.cloid === o.cloid && (x.kind === OutcomeKind.REJECTED || x.kind === OutcomeKind.CANCEL_CONFIRMED))) continue;
      const st = await this.ex.orderStatus(o.cloid);
      if (st.kind === 'cancelled' || st.kind === 'rejected') {
        outs.push(this.simple(o.cloid, st.kind === 'cancelled' ? OutcomeKind.CANCEL_CONFIRMED : OutcomeKind.REJECTED, st.oid));
        this.log.write('cancel_confirmed', { cloid: o.cloid, oid: st.oid, status: st.kind === 'cancelled' ? st.status : st.status, at: this.now() });
      } else if (st.kind === 'open' && this.cancelResults.get(key(o.cloid)) !== 'success') {
        outs.push(this.simple(o.cloid, OutcomeKind.CANCEL_REJECTED, st.oid));
        this.cancelResults.delete(key(o.cloid));
      } else if (st.kind === 'missing' && o.state === 'INTENT_EMITTED') {
        const sub = this.wal.state.submissions[key(o.cloid)];
        if (sub && this.now() >= sub.expiresAfter + this.cfg.unknownGraceMs) outs.push(this.simple(o.cloid, OutcomeKind.REJECTED, 0n));
      }
    }
    rep.outcomes = outs.length;
    await this.report(rt, this.ordered(outs));

    // 6. Observation of the external book and the owner's account, after outcomes are on-chain.
    rt = await this.desk.runtime(this.id);
    live = await this.desk.liveOrders(this.id);
    const obs = await this.observe(rt, live);
    if (!obs) {
      rep.skippedReason = 'exchange book time did not advance';
    } else {
      const t0 = this.now();
      const r = await this.desk.submitTick(obs);
      rep.ticked = true;
      this.log.write('tick', { seq: obs.seq, sourceTimeMs: obs.sourceTimeMs, bid: obs.bestBidE8, ask: obs.bestAskE8, mark: obs.markE8, base: obs.baseBalE8, quote: obs.quoteBalE8, unreported: obs.unreportedFills, tx: r.hash, block: r.block, sentAt: t0, minedAt: this.now() });
    }

    // 7. Exchange-side dead man's switch while anything may rest on the book.
    await this.renewScheduleCancel((await this.desk.liveOrders(this.id)).length > 0);
    this.wal.flush();
    return rep;
  }

  private simple(cloid: bigint, kind: OutcomeKind, oid: bigint): Outcome {
    return { cloid, kind, oid, fillId: 0n, szLots: 0n, pxE8: 0n, feeE8: 0n, timeMs: BigInt(this.now()) };
  }

  /** Acks first, then fills, then terminal confirmations: a cancel is never confirmed ahead of its fills. */
  private ordered(outs: Outcome[]): Outcome[] {
    const rank = (k: OutcomeKind) =>
      k === OutcomeKind.ACK_RESTING || k === OutcomeKind.SUBMISSION_UNKNOWN ? 0 : k === OutcomeKind.FILL ? 1 : 2;
    return [...outs].sort((a, b) => rank(a.kind) - rank(b.kind));
  }

  private async report(rt: Runtime, outs: Outcome[]) {
    if (outs.length === 0) return;
    // Bounded batches keep gas and calldata per transaction predictable.
    for (let i = 0; i < outs.length; i += 16) {
      const batch = outs.slice(i, i + 16);
      const fresh = await this.desk.runtime(this.id);
      const seq = fresh.lastOutcomeSeq + 1n;
      const r = await this.desk.submitOutcomes(this.id, seq, batch);
      this.log.write('outcomes', {
        seq,
        tx: r.hash,
        block: r.block,
        at: this.now(),
        items: batch.map((o) => ({ cloid: o.cloid, kind: OutcomeKind[o.kind], oid: o.oid, fillId: o.fillId, sz: o.szLots, px: o.pxE8, fee: o.feeE8, timeMs: o.timeMs })),
      });
      for (const o of batch) if (o.kind === OutcomeKind.FILL) this.reported.add(o.fillId.toString());
    }
    void rt;
  }

  /** Fills that belong to Staple intents and have not been ingested on-chain. */
  private async newFillOutcomes(rt: Runtime, live: ChainOrder[], checkChain: boolean): Promise<Outcome[]> {
    const fills = await this.fetchFills(rt);
    const ours = this.ownFills(fills, live);
    const outs: Outcome[] = [];
    for (const f of ours) {
      const tid = f.fill.tid.toString();
      if (this.reported.has(tid)) continue;
      if (checkChain || !this.reportedChecked.has(tid)) {
        this.reportedChecked.add(tid);
        if (await this.desk.fillSeen(this.id, f.fill.tid)) {
          this.reported.add(tid);
          continue;
        }
      }
      outs.push({
        cloid: f.cloid,
        kind: OutcomeKind.FILL,
        oid: f.fill.oid,
        fillId: f.fill.tid,
        szLots: f.fill.szLots,
        pxE8: f.fill.pxE8,
        feeE8: f.fill.feeE8,
        timeMs: BigInt(f.fill.timeMs),
      });
      this.log.write('fill_seen', { cloid: f.cloid, tid: f.fill.tid, oid: f.fill.oid, isBuy: f.fill.isBuy, sz: f.fill.szLots, px: f.fill.pxE8, fee: f.fill.feeE8, feeToken: f.fill.feeToken, fillTimeMs: f.fill.timeMs, seenAt: this.now() });
    }
    return outs;
  }
  private reportedChecked = new Set<string>();

  private async fetchFills(rt: Runtime): Promise<NormFill[]> {
    // A mandate that was never activated has placed nothing, so there are no fills of its own to read.
    if (rt.activatedAt === 0n) return [];
    const activatedMs = Number(rt.activatedAt) * 1000;
    const start = Math.max(0, activatedMs - 60_000, (this.wal.state.lastFillPollMs || activatedMs) - this.cfg.fillLookbackMs);
    const fills = await this.ex.fillsSince(start);
    this.wal.state.lastFillPollMs = this.now();
    return fills.filter((f) => f.coin === this.cfg.market.coin);
  }

  private ownFills(fills: NormFill[], live: ChainOrder[]) {
    const byOid = new Map<string, bigint>();
    for (const o of live) if (o.oid !== 0n) byOid.set(o.oid.toString(), o.cloid);
    const known = new Set(Object.keys(this.wal.state.submissions));
    const out: { cloid: bigint; fill: NormFill }[] = [];
    for (const f of fills) {
      const cloid = f.cloid ?? byOid.get(f.oid.toString());
      if (cloid === undefined) continue; // not ours: the watcher and balance reconciliation handle it
      if (!known.has(key(cloid)) && !live.some((o) => o.cloid === cloid)) continue;
      out.push({ cloid, fill: f });
    }
    return out;
  }

  /** External book excluding Staple's own resting orders, plus account balances. */
  private async observe(rt: Runtime, live: ChainOrder[]): Promise<Observation | null> {
    const [book, bal, mark] = await Promise.all([this.ex.book(), this.ex.balances(), this.ex.markE8()]);
    if (BigInt(book.time) <= rt.lastSourceTimeMs) return null;
    const szd = this.cfg.market.szDecimals;
    // Exclude every order that may be on the book: acknowledged ones and any we submitted whose outcome is still
    // unknown. Excluding an unknown order that never landed can only under-state external liquidity (conservative).
    const mine = live.filter(
      (o) =>
        o.state === 'RESTING' ||
        o.state === 'PARTIALLY_FILLED' ||
        o.state === 'ACKNOWLEDGED' ||
        ((o.state === 'SUBMISSION_UNKNOWN' || o.state === 'INTENT_EMITTED') && !!this.wal.state.submissions[key(o.cloid)]),
    );
    const side = (levels: { px: string; sz: string }[], isBuy: boolean) => {
      for (const l of levels) {
        const px = parseScaled(l.px, 8);
        let sz = parseScaled(l.sz, szd);
        for (const o of mine) if (o.isBuy === isBuy && o.pxE8 === px) sz -= o.szLots - o.filledLots;
        if (sz > 0n) return { px, sz };
      }
      return { px: 0n, sz: 0n };
    };
    const bid = side(book.levels[0], true);
    const ask = side(book.levels[1], false);

    // Fills that landed after our fill poll may already be in these balances: count them as unreported.
    let unreported = 0;
    const acct = await this.desk.accounting(this.id);
    if (acct.snapshotTaken && (bal.baseE8 !== acct.expBaseE8 || bal.quoteE8 !== acct.expQuoteE8)) {
      const fills = this.ownFills(await this.fetchFills(rt), live);
      unreported = fills.filter((f) => !this.reported.has(f.fill.tid.toString())).length;
    }
    return {
      mandateId: this.id,
      seq: rt.lastSeq + 1n,
      sourceTimeMs: BigInt(book.time),
      bestBidE8: bid.px,
      bestAskE8: ask.px,
      extBidDepthLots: bid.sz,
      extAskDepthLots: ask.sz,
      markE8: mark,
      baseBalE8: bal.baseE8,
      quoteBalE8: bal.quoteE8,
      unreportedFills: unreported,
    };
  }

  private async renewScheduleCancel(anyLive: boolean) {
    const s = this.wal.state;
    const now = this.now();
    if (anyLive && now - s.lastScheduleCancelMs >= this.cfg.scheduleCancelEveryMs) {
      const at = now + this.cfg.scheduleCancelLeadMs;
      const r = await this.ex.scheduleCancel(at);
      s.lastScheduleCancelMs = now;
      if (r.ok) s.scheduleCancelAt = at;
      this.log.write('schedule_cancel', { at, ok: r.ok, error: r.error });
    } else if (!anyLive && s.scheduleCancelAt && s.scheduleCancelAt > now) {
      const r = await this.ex.scheduleCancel();
      if (r.ok) s.scheduleCancelAt = undefined;
      this.log.write('schedule_cancel_cleared', { ok: r.ok, error: r.error });
    }
  }

  private async checkBudget() {
    const now = this.now();
    if (now - this.lastRateCheck < this.cfg.rateCheckEveryMs) return;
    this.lastRateCheck = now;
    try {
      const r = await this.ex.rateLimit();
      this.budgetOk = r.cap - r.used > this.cfg.minRequestBudget;
      this.log.write('rate_limit', { used: r.used, cap: r.cap, placementsAllowed: this.budgetOk });
    } catch (e) {
      this.log.write('rate_limit_error', { error: (e as Error).message });
    }
  }
}
