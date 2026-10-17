import { HL_INFO } from './config';

async function info<T>(body: Record<string, unknown>): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const r = await fetch(HL_INFO, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HyperCore info ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export interface HlOpenOrder {
  coin: string;
  side: 'B' | 'A';
  limitPx: string;
  sz: string;
  oid: number;
  timestamp: number;
  origSz: string;
  cloid?: string | null;
}
export interface HlFill {
  coin: string;
  px: string;
  sz: string;
  side: 'B' | 'A';
  time: number;
  oid: number;
  tid: number;
  fee: string;
  feeToken: string;
  cloid?: string | null;
  hash: string;
}

export const hl = {
  openOrders: (user: string) => info<HlOpenOrder[]>({ type: 'openOrders', user }),
  fills: (user: string, startTime: number) => info<HlFill[]>({ type: 'userFillsByTime', user, startTime, aggregateByTime: false }),
  balances: (user: string) => info<{ balances: { coin: string; total: string; hold: string }[] }>({ type: 'spotClearinghouseState', user }),
  book: (coin: string) => info<{ time: number; levels: [{ px: string; sz: string; n: number }[], { px: string; sz: string; n: number }[]] }>({ type: 'l2Book', coin }),
  agents: (user: string) => info<{ name: string; address: string; validUntil: number }[]>({ type: 'extraAgents', user }),
  orderStatus: (user: string, cloid: string) => info<any>({ type: 'orderStatus', user, oid: cloid }),
};

export const cloidHex = (c: bigint) => `0x${c.toString(16).padStart(32, '0')}`;
