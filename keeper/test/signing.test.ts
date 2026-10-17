/**
 * Golden vectors produced by the official hyperliquid-python-sdk 0.24.0 (sign_l1_action / sign_agent) with a
 * throwaway key, so our independent signer is checked against the reference implementation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { actionHash, signApproveAgent, signL1Action, signUserAction } from '../src/hl/signing.js';
import { decryptKeys, encryptKeys, makeRedactor } from '../src/keystore.js';
import { NonceCounter } from '../src/hl/client.js';
import { toE8Up } from '../src/exchange.js';

const golden = JSON.parse(readFileSync(join(__dirname, 'hl-signing-golden.json'), 'utf8'));
const KEY = `0x${'11'.repeat(32)}` as const;
const toNum = (h: string) => BigInt(h);

describe('HyperCore signing matches the official SDK', () => {
  const acct = privateKeyToAccount(KEY);
  it('derives the same address', () => expect(acct.address).toBe(golden.address));
  for (const c of golden.cases) {
    it(`${c.name}: action hash and signature`, async () => {
      expect(actionHash(c.action, c.nonce, undefined, c.expiresAfter ?? undefined)).toBe(c.hash);
      const sig = await signL1Action(acct, 'testnet', c.action, c.nonce, undefined, c.expiresAfter ?? undefined);
      expect(toNum(sig.r)).toBe(toNum(c.sig.r));
      expect(toNum(sig.s)).toBe(toNum(c.sig.s));
      expect(sig.v).toBe(c.sig.v);
    });
  }
  it('approveAgent (user-signed) signature', async () => {
    const sig = await signApproveAgent(acct, golden.approveAgent.action);
    expect(toNum(sig.r)).toBe(toNum(golden.approveAgent.sig.r));
    expect(toNum(sig.s)).toBe(toNum(golden.approveAgent.sig.s));
    expect(sig.v).toBe(golden.approveAgent.sig.v);
  });
});

describe('spotSend (user-signed transfer) matches the official SDK', () => {
  it('signature', async () => {
    const g = JSON.parse(readFileSync(join(__dirname, 'hl-spotsend-golden.json'), 'utf8'));
    const a = g.action;
    const sig = await signUserAction(
      privateKeyToAccount(KEY),
      'HyperliquidTransaction:SpotSend',
      [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'destination', type: 'string' },
        { name: 'token', type: 'string' },
        { name: 'amount', type: 'string' },
        { name: 'time', type: 'uint64' },
      ],
      { hyperliquidChain: 'Testnet', destination: a.destination, token: a.token, amount: a.amount, time: BigInt(a.time) },
      '0x66eee',
    );
    expect(toNum(sig.r)).toBe(toNum(g.sig.r));
    expect(toNum(sig.s)).toBe(toNum(g.sig.s));
    expect(sig.v).toBe(g.sig.v);
  });
});

describe('keys and nonces', () => {
  it('keystore round-trips and rejects a wrong passphrase', () => {
    const env = encryptKeys({ agent: KEY }, 'correct horse battery staple');
    expect(JSON.stringify(env)).not.toContain('1111111111');
    expect(decryptKeys(env, 'correct horse battery staple').agent).toBe(KEY);
    expect(() => decryptKeys(env, 'wrong passphrase value!!')).toThrow();
  });
  it('redacts exact secrets but keeps tx hashes', () => {
    const r = makeRedactor([KEY]);
    const tx = `0x${'ab'.repeat(32)}`;
    expect(r(`key=${KEY} tx=${tx}`)).toBe(`key=<redacted-key> tx=${tx}`);
  });
  it('nonces are strictly increasing even within one millisecond', () => {
    const n = new NonceCounter();
    const xs = Array.from({ length: 1000 }, () => n.next());
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
  });
  it('fee conversion rounds excess precision up', () => {
    expect(toE8Up('0.000123456789')).toBe(12346n);
    expect(toE8Up('0.0004')).toBe(40000n);
  });
});
