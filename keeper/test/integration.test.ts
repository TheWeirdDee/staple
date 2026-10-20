/**
 * Offline integration: real contracts on a local EVM node + the real keeper, against the exchange TEST DOUBLE.
 * Covers G2/G3 failure cases that cannot be forced safely on a shared testnet market.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
let port = 18545;
afterEach(() => h?.close());

async function boot() {
  h = await startHarness(port++);
  await h.owner('activate', [h.id]);
  await h.heartbeat();
  return h;
}

const events = () =>
  readFileSync(join(h.stateDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

describe('keeper live loop against the exchange double', () => {
  it('a mandate that was never activated steps cleanly and places nothing', async () => {
    h = await startHarness(port++);
    await h.heartbeat();
    const k = h.newKeeper();
    await k.step();
    await k.step();
    expect(h.fake.placeCalls).toBe(0);
    expect(events().some((e) => e.kind === 'step_error')).toBe(false);
  }, 60_000);

  it('places intents once, reconciles fills exactly once and keeps reservations conservative', async () => {
    await boot();
    const k = h.newKeeper();
    let r = await k.step(); // snapshot + first ladder (intents emitted by this tick)
    r = await k.step(); // keeper executes the intents
    expect(r.placed).toBe(4);
    expect(h.fake.orders.size).toBe(4);
    let live = await h.live();
    expect(live.every((o) => o.state === 'RESTING')).toBe(true);

    // Controlled taker lifts 1 lot of the best bid.
    const bid = live.find((o) => o.isBuy && o.level === 0)!;
    h.fake.takerHit(bid.cloid, 1n);
    h.fake.duplicateFills = true; // the fill feed delivers it twice
    await h.advance(3);
    await h.heartbeat();
    await k.step();
    const acct = await h.chainDesk.accounting(h.id);
    expect(acct.expBaseE8).toBe(h.fake.baseE8);
    expect(acct.expQuoteE8).toBe(h.fake.quoteE8);
    live = await h.live();
    expect(live.find((o) => o.cloid === bid.cloid)!.filledLots).toBe(1n);
    expect((await h.runtime()).state).toBe('ACTIVE');
    expect(h.fake.placeCalls).toBe(4); // no duplicate placements
  }, 60_000);

  it('resolves a lost placement response by query, never by blind retry', async () => {
    await boot();
    const k = h.newKeeper();
    await k.step();
    h.fake.dropNextPlaceResponse = 'accepted';
    await k.step();
    let live = await h.live();
    expect(live.filter((o) => o.state === 'SUBMISSION_UNKNOWN')).toHaveLength(1);
    // While unknown, no new exposure and no retry.
    await h.advance(2);
    await h.heartbeat();
    await k.step();
    expect(h.fake.placeCalls).toBe(4);
    await h.advance(12); // past expiresAfter + grace
    await h.heartbeat();
    await k.step();
    live = await h.live();
    expect(live.filter((o) => o.state === 'SUBMISSION_UNKNOWN')).toHaveLength(0);
    expect(live.filter((o) => o.state === 'RESTING')).toHaveLength(4);
    expect(h.fake.orders.size).toBe(4);
  }, 60_000);

  it('a placement that never reached the exchange resolves to rejected and is re-quoted under a new id', async () => {
    await boot();
    const k = h.newKeeper();
    await k.step();
    h.fake.dropNextPlaceResponse = 'not_accepted';
    await k.step();
    await h.advance(12);
    await h.heartbeat();
    await k.step(); // resolves unknown -> REJECTED
    await h.advance(1);
    await h.heartbeat();
    await k.step(); // tick re-emits the missing level
    await k.step(); // keeper places it
    const live = await h.live();
    expect(live).toHaveLength(4);
    expect(h.fake.orders.size).toBe(4);
    expect(events().some((e) => e.kind === 'unknown_resolved' && e.status === 'missing')).toBe(true);
  }, 60_000);

  it('restart recovery reconciles exchange state before any new exposure', async () => {
    await boot();
    let k = h.newKeeper();
    await k.step();
    h.fake.dropNextPlaceResponse = 'accepted';
    await k.step(); // crash right after: one placement outcome unknown on-chain
    const live0 = await h.live();
    const unknown = live0.find((o) => o.state === 'SUBMISSION_UNKNOWN')!;
    h.fake.takerHit(unknown.cloid, 1n); // and it filled while we were down
    k = h.newKeeper(); // restart with the persisted WAL
    let r = await k.step();
    expect(r.recovered).toBe(false); // still inside expiresAfter window
    await h.advance(12);
    await h.heartbeat();
    r = await k.step();
    expect(r.recovered).toBe(true);
    const o = (await h.live()).find((x) => x.cloid === unknown.cloid)!;
    expect(o.state).toBe('PARTIALLY_FILLED');
    const acct = await h.chainDesk.accounting(h.id);
    expect(acct.expBaseE8).toBe(h.fake.baseE8);
    expect(h.fake.placeCalls).toBe(4);
  }, 60_000);

  it('pause with a delayed cancel and a partial fill during cancellation reconciles conservatively', async () => {
    await boot();
    const k = h.newKeeper();
    await k.step();
    await k.step();
    h.fake.delayCancels = 4;
    await h.owner('pause', [h.id]);
    await k.step(); // cancels sent, exchange acknowledges but orders still open
    expect((await h.runtime()).state).toBe('PAUSING');
    const live = await h.live();
    expect(live).toHaveLength(4);
    const ask = live.find((o) => !o.isBuy)!;
    h.fake.takerHit(ask.cloid, 2n); // fills while the cancel is pending
    h.fake.flushDelayedCancels(live.map((o) => o.cloid));
    await h.advance(2);
    await k.step();
    expect((await h.runtime()).state).toBe('PAUSED');
    const acct = await h.chainDesk.accounting(h.id);
    expect(acct.expBaseE8).toBe(h.fake.baseE8);
    expect(acct.expQuoteE8).toBe(h.fake.quoteE8);
    expect(events().filter((e) => e.kind === 'cancel_confirmed')).toHaveLength(4);
  }, 60_000);

  it('a rejected cancel keeps the order reserved and is retried after the on-chain timeout', async () => {
    await boot();
    const k = h.newKeeper();
    await k.step();
    await k.step();
    h.fake.rejectNextCancel = true;
    await h.owner('pause', [h.id]);
    await k.step();
    expect((await h.live()).length).toBe(1); // three confirmed, one rejected and still live
    await h.advance(25); // cancelTimeoutSec = 20
    await h.poke(); // contract re-emits the cancel intent
    await k.step();
    expect((await h.runtime()).state).toBe('PAUSED');
  }, 60_000);

  it('keeper outage: chain watchdog stops quoting and the exchange-side scheduled cancel removes orders', async () => {
    await boot();
    const k = h.newKeeper();
    await k.step();
    await k.step();
    expect(h.fake.scheduledAt).toBeDefined();
    // Keeper stops entirely. No ticks arrive.
    await h.advance(20);
    await h.heartbeat();
    await h.poke(); // independent timer: STALE halt + cancel intents
    expect((await h.runtime()).halt).toBe('STALE');
    await h.advance(80); // dead man's switch fires at the exchange
    expect((await h.fake.openOrders()).length).toBe(0);
    // Keeper comes back: recovery confirms the exchange-side cancellations before anything else.
    const before = (await h.live()).map((o) => o.cloid);
    const k2 = h.newKeeper();
    await h.heartbeat();
    await k2.step();
    expect(h.fake.placeCalls).toBe(4); // nothing placed during recovery
    const after = await h.live();
    expect(after.some((o) => before.includes(o.cloid))).toBe(false); // old orders confirmed terminal
    const conf = events().filter((e) => e.kind === 'outcomes').flatMap((e) => e.items);
    expect(conf.filter((i: any) => i.kind === 'CANCEL_CONFIRMED')).toHaveLength(4);
    // Only then did a fresh, reconciled observation resume quoting with new intents.
    expect((await h.runtime()).halt).toBe('NONE');
    expect(after.every((o) => o.state === 'INTENT_EMITTED')).toBe(true);
  }, 60_000);

  it('unrelated account activity requires reconciliation', async () => {
    await boot();
    const k = h.newKeeper();
    await k.step();
    await k.step();
    h.fake.quoteE8 += 25_00000000n; // a deposit no intent explains
    await h.advance(2);
    await k.step();
    expect((await h.runtime()).state).toBe('RECONCILIATION_REQUIRED');
    const live = await h.live();
    expect(live.every((o) => o.cancelRequestedAt > 0n)).toBe(true);
  }, 60_000);

  it('excludes its own resting orders from the external book estimate', async () => {
    await boot();
    const k = h.newKeeper();
    await k.step();
    await k.step();
    await h.advance(2);
    await h.heartbeat();
    await k.step();
    const ticks = events().filter((e) => e.kind === 'tick');
    const last = ticks[ticks.length - 1];
    expect(last.bid).toBe('453420000');
    expect(last.ask).toBe('457950000');
  }, 60_000);
});
