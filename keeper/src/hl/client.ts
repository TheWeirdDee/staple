import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { signApproveAgent, signL1Action, type ApproveAgentAction, type Network } from './signing.js';

export const HL_API: Record<Network, string> = {
  testnet: 'https://api.hyperliquid-testnet.xyz',
  mainnet: 'https://api.hyperliquid.xyz',
};

export class TransportError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

export interface L2Level {
  px: string;
  sz: string;
  n: number;
}
export interface L2Book {
  coin: string;
  time: number;
  levels: [L2Level[], L2Level[]];
}
export interface SpotBalance {
  coin: string;
  token: number;
  total: string;
  hold: string;
}
export interface OpenOrder {
  coin: string;
  side: 'B' | 'A';
  limitPx: string;
  sz: string;
  oid: number;
  timestamp: number;
  origSz: string;
  cloid?: string | null;
}
export interface Fill {
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
  crossed: boolean;
  hash: string;
  dir: string;
}
export type OrderStatusResp =
  | { status: 'unknownOid' }
  | {
      status: 'order';
      order: { order: OpenOrder & { cloid: string | null }; status: string; statusTimestamp: number };
    };

export type OrderWire = {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: 'Alo' | 'Ioc' | 'Gtc' } };
  c?: string;
};

/** Per-signer nonce counter: strictly increasing, fast-forwarded to wall-clock milliseconds. */
export class NonceCounter {
  private last = 0;
  next(): number {
    this.last = Math.max(Date.now(), this.last + 1);
    return this.last;
  }
}

export class HyperliquidClient {
  readonly base: string;
  private nonces = new NonceCounter();
  readonly account?: PrivateKeyAccount;

  constructor(
    readonly network: Network,
    signerKey?: Hex,
    private timeoutMs = 8_000,
  ) {
    this.base = HL_API[network];
    if (signerKey) this.account = privateKeyToAccount(signerKey);
  }

  private async post<T>(path: '/info' | '/exchange', body: unknown): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new TransportError(`${path} request failed: ${(e as Error).message}`, e);
    } finally {
      clearTimeout(t);
    }
    const text = await res.text();
    if (!res.ok) throw new TransportError(`${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TransportError(`${path} returned non-JSON: ${text.slice(0, 300)}`);
    }
  }

  info<T>(body: Record<string, unknown>): Promise<T> {
    return this.post<T>('/info', body);
  }

  // ------------------------------------------------------------------ info

  l2Book(coin: string) {
    return this.info<L2Book>({ type: 'l2Book', coin });
  }
  spotMetaAndAssetCtxs() {
    return this.info<[{ universe: { name: string; index: number; tokens: [number, number] }[]; tokens: any[] }, any[]]>(
      { type: 'spotMetaAndAssetCtxs' },
    );
  }
  spotBalances(user: Hex) {
    return this.info<{ balances: SpotBalance[] }>({ type: 'spotClearinghouseState', user });
  }
  openOrders(user: Hex) {
    return this.info<OpenOrder[]>({ type: 'openOrders', user });
  }
  orderStatus(user: Hex, oidOrCloid: number | string) {
    return this.info<OrderStatusResp>({ type: 'orderStatus', user, oid: oidOrCloid });
  }
  userFillsByTime(user: Hex, startTime: number) {
    return this.info<Fill[]>({ type: 'userFillsByTime', user, startTime, aggregateByTime: false });
  }
  extraAgents(user: Hex) {
    return this.info<{ name: string; address: string; validUntil: number }[]>({ type: 'extraAgents', user });
  }
  userRateLimit(user: Hex) {
    return this.info<{ cumVlm: string; nRequestsUsed: number; nRequestsCap: number }>({ type: 'userRateLimit', user });
  }

  // -------------------------------------------------------------- exchange

  private async l1(action: unknown, vaultAddress?: Hex, expiresAfter?: number) {
    if (!this.account) throw new Error('no signer configured');
    const nonce = this.nonces.next();
    const signature = await signL1Action(this.account, this.network, action, nonce, vaultAddress, expiresAfter);
    const body: Record<string, unknown> = { action, nonce, signature };
    if (vaultAddress) body.vaultAddress = vaultAddress;
    if (expiresAfter !== undefined) body.expiresAfter = expiresAfter;
    return this.post<any>('/exchange', body);
  }

  order(orders: OrderWire[], expiresAfter?: number) {
    return this.l1({ type: 'order', orders, grouping: 'na' }, undefined, expiresAfter);
  }
  cancelByCloid(cancels: { asset: number; cloid: string }[]) {
    return this.l1({ type: 'cancelByCloid', cancels });
  }
  cancel(cancels: { a: number; o: number }[]) {
    return this.l1({ type: 'cancel', cancels });
  }
  /** Exchange-side dead man's switch: cancels all open orders at `time` unless renewed. Max 10 triggers/day. */
  scheduleCancel(time?: number) {
    return this.l1(time === undefined ? { type: 'scheduleCancel' } : { type: 'scheduleCancel', time });
  }

  /** User-signed action: only the account owner (master key) can approve or replace an API agent. */
  async approveAgent(agentAddress: Hex, agentName: string, signatureChainId: Hex) {
    if (!this.account) throw new Error('no signer configured');
    const nonce = this.nonces.next();
    const action: ApproveAgentAction = {
      type: 'approveAgent',
      signatureChainId,
      hyperliquidChain: this.network === 'mainnet' ? 'Mainnet' : 'Testnet',
      agentAddress: agentAddress.toLowerCase() as Hex,
      agentName,
      nonce,
    };
    const signature = await signApproveAgent(this.account, action);
    return this.post<any>('/exchange', { action, nonce, signature });
  }
}
