import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createWalletClient, custom, type Hex } from 'viem';
import { elysiumTestnet } from './config';
import { pub } from './desk';

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<any>; on?: any; removeListener?: any };
declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

interface WalletState {
  available: boolean;
  address?: Hex;
  chainId?: number;
  connecting: boolean;
  error?: string;
  connect: () => Promise<void>;
  switchToElysium: () => Promise<void>;
  onRightChain: boolean;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const eth = typeof window !== 'undefined' ? window.ethereum : undefined;
  const [address, setAddress] = useState<Hex>();
  const [chainId, setChainId] = useState<number>();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!eth) return;
    // Restore a previously authorised session without prompting.
    eth.request({ method: 'eth_accounts' }).then((a: Hex[]) => a[0] && setAddress(a[0])).catch(() => undefined);
    eth.request({ method: 'eth_chainId' }).then((c: string) => setChainId(Number(c))).catch(() => undefined);
    const onAcc = (a: Hex[]) => setAddress(a[0]);
    const onChain = (c: string) => setChainId(Number(c));
    eth.on?.('accountsChanged', onAcc);
    eth.on?.('chainChanged', onChain);
    return () => {
      eth.removeListener?.('accountsChanged', onAcc);
      eth.removeListener?.('chainChanged', onChain);
    };
  }, [eth]);

  const connect = useCallback(async () => {
    if (!eth) {
      setError('No browser wallet found. Install one (for example Rabby or MetaMask) to use the owner console.');
      return;
    }
    setConnecting(true);
    setError(undefined);
    try {
      const a: Hex[] = await eth.request({ method: 'eth_requestAccounts' });
      setAddress(a[0]);
      setChainId(Number(await eth.request({ method: 'eth_chainId' })));
    } catch (e) {
      setError(friendly(e));
    } finally {
      setConnecting(false);
    }
  }, [eth]);

  const switchToElysium = useCallback(async () => {
    if (!eth) return;
    const hex = `0x${elysiumTestnet.id.toString(16)}`;
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
    } catch (e: any) {
      if (e?.code === 4902 || /Unrecognized|not added/i.test(String(e?.message))) {
        await eth.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: hex,
              chainName: elysiumTestnet.name,
              nativeCurrency: elysiumTestnet.nativeCurrency,
              rpcUrls: elysiumTestnet.rpcUrls.default.http,
              blockExplorerUrls: [elysiumTestnet.blockExplorers.default.url],
            },
          ],
        });
      } else {
        setError(friendly(e));
      }
    }
  }, [eth]);

  const value = useMemo(
    () => ({
      available: !!eth,
      address,
      chainId,
      connecting,
      error,
      connect,
      switchToElysium,
      onRightChain: chainId === elysiumTestnet.id,
    }),
    [eth, address, chainId, connecting, error, connect, switchToElysium],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet() {
  const v = useContext(Ctx);
  if (!v) throw new Error('WalletProvider missing');
  return v;
}

export function walletClient(account: Hex) {
  if (!window.ethereum) throw new Error('No browser wallet');
  return createWalletClient({ chain: elysiumTestnet, transport: custom(window.ethereum), account });
}

/** Sends a contract write and waits for inclusion. Distinguishes "submitted" from "confirmed". */
export async function sendTx(
  account: Hex,
  req: { address: Hex; abi: any; functionName: string; args: unknown[] },
  onSubmitted?: (hash: Hex) => void,
): Promise<Hex> {
  const w = walletClient(account);
  await pub.simulateContract({ ...req, account } as any); // surface reverts before the wallet prompt
  const hash = await w.writeContract({ ...req, chain: elysiumTestnet, account } as any);
  onSubmitted?.(hash);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (r.status !== 'success') throw new Error(`Transaction reverted on-chain (${hash}).`);
  return hash;
}

/** Turns wallet and contract errors into an actionable sentence. */
export function friendly(e: unknown): string {
  const m = String((e as any)?.shortMessage ?? (e as any)?.message ?? e);
  if (/User rejected|denied|4001/i.test(m)) return 'You cancelled the request in your wallet. Nothing was sent.';
  if (/insufficient funds/i.test(m)) return 'Your wallet does not have enough testnet HYPE for gas on Elysium. Use the Elysium testnet faucet.';
  if (/NotOwner/.test(m)) return 'Only the mandate owner can do this. Connect the owner wallet.';
  if (/LiveOrdersOutstanding/.test(m)) return 'Orders are still live on the exchange. Wait for confirmed cancellations, then retry.';
  if (/FeesUnavailable/.test(m)) return 'Deposit prepaid service fees before activating.';
  if (/Expired/.test(m)) return 'The policy has expired. Publish a new version with a later expiry first.';
  if (/InvalidPolicy/.test(m)) {
    const f = m.match(/InvalidPolicy\("?([\w.]+)/);
    return `The contract rejected the policy${f ? ` (${f[1]})` : ''}. Check the highlighted field.`;
  }
  if (/BadState/.test(m)) return 'This action is not available in the mandate’s current state. Refresh and check the status.';
  return m.length > 220 ? `${m.slice(0, 220)}…` : m;
}
