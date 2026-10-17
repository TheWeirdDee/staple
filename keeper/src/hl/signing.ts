/**
 * HyperCore action signing, following the scheme of the official Python SDK (sign_l1_action and
 * sign_user_signed_action). Field order matters for msgpack; addresses are lowercased before signing.
 */
import { encode } from '@msgpack/msgpack';
import { concat, keccak256, toBytes, toHex, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

export type Network = 'testnet' | 'mainnet';

export interface Signature {
  r: Hex;
  s: Hex;
  v: number;
}

function u64be(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n);
  return b;
}

/** keccak(msgpack(action) || nonce_be64 || vault flag [|| 0x00 || expiresAfter_be64]) */
export function actionHash(action: unknown, nonce: number, vaultAddress?: Hex, expiresAfter?: number): Hex {
  const parts: Uint8Array[] = [encode(action), u64be(BigInt(nonce))];
  if (vaultAddress) {
    parts.push(new Uint8Array([1]), toBytes(vaultAddress.toLowerCase() as Hex));
  } else {
    parts.push(new Uint8Array([0]));
  }
  if (expiresAfter !== undefined) {
    parts.push(new Uint8Array([0]), u64be(BigInt(expiresAfter)));
  }
  return keccak256(concat(parts));
}

function splitSig(sig: Hex): Signature {
  const b = toBytes(sig);
  return { r: toHex(b.slice(0, 32)), s: toHex(b.slice(32, 64)), v: b[64] };
}

/** Signs an L1 action (orders, cancels, scheduleCancel) as a phantom agent. */
export async function signL1Action(
  account: PrivateKeyAccount,
  network: Network,
  action: unknown,
  nonce: number,
  vaultAddress?: Hex,
  expiresAfter?: number,
): Promise<Signature> {
  const connectionId = actionHash(action, nonce, vaultAddress, expiresAfter);
  const sig = await account.signTypedData({
    domain: {
      name: 'Exchange',
      version: '1',
      chainId: 1337,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    },
    types: {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' },
      ],
    },
    primaryType: 'Agent',
    message: { source: network === 'mainnet' ? 'a' : 'b', connectionId },
  });
  return splitSig(sig);
}

export const APPROVE_AGENT_TYPES = {
  'HyperliquidTransaction:ApproveAgent': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'agentAddress', type: 'address' },
    { name: 'agentName', type: 'string' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

export interface ApproveAgentAction {
  type: 'approveAgent';
  signatureChainId: Hex;
  hyperliquidChain: 'Testnet' | 'Mainnet';
  agentAddress: Hex;
  agentName: string;
  nonce: number;
}

/** Typed data for a user-signed approveAgent; also used by the web console with the owner's wallet. */
export function approveAgentTypedData(a: ApproveAgentAction) {
  return {
    domain: {
      name: 'HyperliquidSignTransaction',
      version: '1',
      chainId: Number(BigInt(a.signatureChainId)),
      verifyingContract: '0x0000000000000000000000000000000000000000' as Hex,
    },
    types: APPROVE_AGENT_TYPES,
    primaryType: 'HyperliquidTransaction:ApproveAgent' as const,
    message: {
      hyperliquidChain: a.hyperliquidChain,
      agentAddress: a.agentAddress.toLowerCase() as Hex,
      agentName: a.agentName,
      nonce: BigInt(a.nonce),
    },
  };
}

export async function signApproveAgent(account: PrivateKeyAccount, a: ApproveAgentAction): Promise<Signature> {
  return splitSig(await account.signTypedData(approveAgentTypedData(a)));
}

/** Generic user-signed action (e.g. spotSend, usdSend), signed by the account owner's master key. */
export async function signUserAction(
  account: PrivateKeyAccount,
  primaryType: string,
  fields: { name: string; type: string }[],
  message: Record<string, unknown>,
  signatureChainId: Hex,
): Promise<Signature> {
  const sig = await account.signTypedData({
    domain: {
      name: 'HyperliquidSignTransaction',
      version: '1',
      chainId: Number(BigInt(signatureChainId)),
      verifyingContract: '0x0000000000000000000000000000000000000000',
    },
    types: { [primaryType]: fields },
    primaryType,
    message,
  } as any);
  return splitSig(sig);
}
