const E8 = 100_000_000n;

/** Formats an integer scaled by 1e8 with fixed decimals, rounding half away from zero for display only. */
export function fmtE8(v: bigint | undefined | null, decimals = 2): string {
  if (v === undefined || v === null) return '—';
  const neg = v < 0n;
  let a = neg ? -v : v;
  const scale = 10n ** BigInt(8 - decimals);
  a = (a + scale / 2n) / scale; // now scaled by 10^decimals
  const d = 10n ** BigInt(decimals);
  const whole = (a / d).toLocaleString('en-US');
  const frac = decimals ? '.' + (a % d).toString().padStart(decimals, '0') : '';
  return `${neg && a !== 0n ? '−' : ''}${whole}${frac}`;
}

export function fmtPx(v: bigint | undefined | null): string {
  if (v === undefined || v === null || v === 0n) return '—';
  const whole = v / E8;
  const frac = (v % E8).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function fmtSigned(v: bigint | undefined | null, decimals = 2): string {
  if (v === undefined || v === null) return '—';
  return v > 0n ? `+${fmtE8(v, decimals)}` : fmtE8(v, decimals);
}

export function fmtBps(v: number | bigint): string {
  return `${Number(v)} bps`;
}

export function shortAddr(a?: string): string {
  if (!a) return '—';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function shortHash(h?: string): string {
  if (!h) return '—';
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

export function ago(sec: number | bigint | undefined, now = Date.now() / 1000): string {
  if (sec === undefined) return '—';
  const s = Number(sec);
  if (!s) return 'never';
  const d = Math.max(0, Math.round(now - s));
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ${d % 60}s ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export function utc(sec: number | bigint | undefined): string {
  if (!sec) return '—';
  return new Date(Number(sec) * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

export function duration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

/** Parses a human decimal into an integer scaled by 10^scale. Returns null when invalid or too precise. */
export function parseDec(v: string, scale: number): bigint | null {
  const t = v.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  if (f.replace(/0+$/, '').length > scale) return null;
  return BigInt(w) * 10n ** BigInt(scale) + BigInt((f.replace(/0+$/, '') || '0').padEnd(scale, '0'));
}
