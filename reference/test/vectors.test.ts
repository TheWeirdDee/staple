import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildVectors } from '../src/vectors.js';
import {
  allowedDecimals,
  ladder,
  lotsToWire,
  parseScaled,
  pxToWire,
  reservationFits,
  roundPx,
  skew,
} from '../src/quote.js';
import { campaignPolicy, diffPolicies, riskIncreasingFields, validatePolicy } from '../src/policy.js';

const ser = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
const q8 = (v: string) => parseScaled(v, 8);

describe('frozen vectors', () => {
  it('committed vectors match the reference implementation', () => {
    const committed = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'quote-vectors.json'), 'utf8'));
    expect(ser(buildVectors())).toEqual(committed);
  });
});

describe('price precision', () => {
  it('follows 5 significant figures and the spot decimal cap', () => {
    expect(allowedDecimals(q8('4.55685'), 0, true)).toBe(4);
    expect(allowedDecimals(q8('12345.6'), 0, true)).toBe(0);
    expect(allowedDecimals(q8('0.00014613'), 0, true)).toBe(8);
    expect(allowedDecimals(q8('0.0001234'), 2, true)).toBe(6);
  });
  it('rounds bids down and asks up', () => {
    expect(roundPx(q8('4.55685'), 0, true, false)).toBe(q8('4.5568'));
    expect(roundPx(q8('4.55685'), 0, true, true)).toBe(q8('4.5569'));
  });
  it('every emitted price is a valid exchange price', () => {
    for (const l of buildVectors().ladders) {
      for (const lv of [...l.expected.bids, ...l.expected.asks]) {
        if (!lv.valid) continue;
        const wire = pxToWire(lv.pxE8);
        const digits = wire.replace('.', '').replace(/^0+/, '');
        const isInt = !wire.includes('.');
        expect(isInt || digits.length <= 5).toBe(true);
        expect(roundPx(lv.pxE8, l.input.market.szDecimals, true, false)).toBe(lv.pxE8);
      }
    }
  });
  it('formats wire strings without trailing zeros', () => {
    expect(pxToWire(q8('4.5300'))).toBe('4.53');
    expect(pxToWire(q8('10'))).toBe('10');
    expect(lotsToWire(1500n, 2)).toBe('15');
    expect(lotsToWire(1505n, 2)).toBe('15.05');
  });
  it('rejects excess precision instead of silently rounding', () => {
    expect(() => parseScaled('0.000000001', 8)).toThrow();
    expect(parseScaled('1.10000000', 8)).toBe(110000000n);
  });
});

describe('skew and ladder', () => {
  const p = campaignPolicy(2_000_000_000n);
  it('skews down when long and up when short, clamped', () => {
    expect(skew(q8('45'), p.exposure, 30)).toBe(22);
    expect(skew(q8('12'), p.exposure, 30)).toBe(-27);
    expect(skew(q8('500'), p.exposure, 30)).toBe(30);
  });
  it('bids stay below asks at every level', () => {
    for (const l of buildVectors().ladders) {
      l.expected.bids.forEach((b, i) => {
        const a = l.expected.asks[i];
        if (b.valid && a.valid) expect(b.pxE8 < a.pxE8).toBe(true);
      });
    }
  });
  it('never emits more than the configured levels', () => {
    const out = ladder({
      midE8: q8('4.5'),
      inventoryE8: q8('30'),
      extBestBidE8: 0n,
      extBestAskE8: 0n,
      healthy: false,
      market: p.market,
      quotes: { ...p.quotes, levels: 2 },
      exposure: p.exposure,
    });
    expect(out.bids.filter((b) => b.szLots > 0n)).toHaveLength(2);
  });
});

describe('reservations', () => {
  const e = campaignPolicy(2_000_000_000n).exposure;
  it('cancel-requested orders still count: no capacity until terminal', () => {
    const t = { buyLots: 18n, sellLots: 0n, buyQuoteE8: q8('82'), notionalE8: q8('82') };
    expect(reservationFits(t, q8('30'), q8('500'), true, q8('4.5'), 3n, 0, { ...e, maxOutstandingNotionalE8: q8('1000') }).ok).toBe(false);
  });
  it('does not net buys against sells', () => {
    const t = { buyLots: 30n, sellLots: 18n, buyQuoteE8: 0n, notionalE8: 0n };
    expect(reservationFits(t, q8('30'), q8('500'), false, q8('4.6'), 3n, 0, { ...e, maxOutstandingNotionalE8: q8('1000') }).ok).toBe(false);
  });
});

describe('policy', () => {
  const now = 1_800_000_000n;
  const p = campaignPolicy(now + 86_400n);
  it('campaign policy is valid', () => expect(validatePolicy(p, now)).toBeNull());
  it('rejects requote threshold >= spread', () =>
    expect(validatePolicy({ ...p, quotes: { ...p.quotes, requoteBps: 40 } }, now)).toBe('quotes.requoteBps'));
  it('rejects inverted inventory bounds', () =>
    expect(validatePolicy({ ...p, exposure: { ...p.exposure, minBaseE8: q8('40') } }, now)).toBe('exposure.inventoryBounds'));
  it('flags risk-increasing edits and shows a diff', () => {
    const wider = { ...p, quotes: { ...p.quotes, spreadBps: 60 } };
    const bigger = { ...p, quotes: { ...p.quotes, sizeLots: 5n } };
    expect(riskIncreasingFields(p, wider)).toEqual([]);
    expect(riskIncreasingFields(p, bigger)).toEqual(['quotes.sizeLots']);
    expect(diffPolicies(p, bigger)).toEqual([
      { key: 'quotes.sizeLots', label: 'Size per level (lots)', from: '3', to: '5', riskIncreasing: true },
    ]);
  });
});
