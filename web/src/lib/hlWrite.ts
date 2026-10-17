import type { Hex } from 'viem';
import { walletClient } from './wallet';

export const HL_EXCHANGE = 'https://api.hyperliquid-testnet.xyz/exchange';
export const ZERO = '0x0000000000000000000000000000000000000000' as Hex;

/**
 * Owner-signed approveAgent (a HyperCore "user-signed action"). The signature domain uses the wallet's current
 * chain id as signatureChainId, which HyperCore accepts. Approving the zero address under the same name removes
 * the named agent; this behaviour is verified on testnet before relying on it (see docs/dependencies.md).
 */
export async function ownerApproveAgent(owner: Hex, chainId: number, agentAddress: Hex, agentName: string) {
  const nonce = Date.now();
  const action = {
    type: 'approveAgent',
    signatureChainId: `0x${chainId.toString(16)}`,
    hyperliquidChain: 'Testnet',
    agentAddress: agentAddress.toLowerCase(),
    agentName,
    nonce,
  };
  const w = walletClient(owner);
  const sig = await w.signTypedData({
    account: owner,
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId, verifyingContract: ZERO },
    types: {
      'HyperliquidTransaction:ApproveAgent': [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'agentAddress', type: 'address' },
        { name: 'agentName', type: 'string' },
        { name: 'nonce', type: 'uint64' },
      ],
    },
    primaryType: 'HyperliquidTransaction:ApproveAgent',
    message: { hyperliquidChain: 'Testnet', agentAddress: action.agentAddress as Hex, agentName, nonce: BigInt(nonce) },
  });
  const r = { r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}`, v: parseInt(sig.slice(130, 132), 16) };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(HL_EXCHANGE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, nonce, signature: r }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(
      (e as Error).name === 'AbortError'
        ? 'Hyperliquid did not answer within 20 seconds. Nothing was confirmed; check the agent list before retrying.'
        : `Could not reach Hyperliquid: ${(e as Error).message}. Nothing was confirmed.`,
    );
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.status !== 'ok') {
    throw new Error(`Hyperliquid rejected the request: ${JSON.stringify(body?.response ?? body ?? res.status)}`);
  }
  return body;
}
