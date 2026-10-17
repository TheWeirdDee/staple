import { describe, expect, it } from 'vitest';
import { armAt } from '../src/campaign.js';

describe('campaign schedule', () => {
  it('alternates equal blocks in ABBA order and resumes deterministically after a restart', () => {
    const start = 1_800_000_000;
    const arms = Array.from({ length: 8 }, (_, i) => armAt(start + i * 1800 + 5, start, 1800).arm);
    expect(arms).toEqual(['on', 'off', 'off', 'on', 'on', 'off', 'off', 'on']);
    expect(armAt(start + 1799, start, 1800)).toEqual({ idx: 0, arm: 'on', endsAt: start + 1800 });
    // Equal time in each arm over any whole number of 4-block cycles.
    const on = Array.from({ length: 48 }, (_, i) => armAt(start + i * 1800, start, 1800).arm).filter((a) => a === 'on').length;
    expect(on).toBe(24);
  });
});
