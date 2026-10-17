/**
 * Deploys the Staple contracts (linking the external libraries) and optionally creates a mandate.
 * Used by tests against a local node and by the testnet deployment command (see docs/runbook.md).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Chain, Hex, PublicClient, WalletClient } from 'viem';
import {
  DeskAccountingBytecode,
  DeskOrdersBytecode,
  DeskOrdersLinkReferences,
  MandateRegistryAbi,
  MandateRegistryBytecode,
  QuoteEngineBytecode,
  StapleDeskAbi,
  StapleDeskBytecode,
  StapleDeskLinkReferences,
  TestFeeTokenAbi,
  TestFeeTokenBytecode,
} from '@staple/reference/abi';
import type { Policy } from '@staple/reference';

type LinkRefs = Record<string, Record<string, readonly { start: number; length: number }[]>>;

export function link(bytecode: string, refs: LinkRefs, libs: Record<string, Hex>): Hex {
  let code = bytecode.replace(/^0x/, '');
  for (const file of Object.keys(refs)) {
    for (const [name, spots] of Object.entries(refs[file])) {
      const addr = libs[name];
      if (!addr) throw new Error(`missing library ${name}`);
      for (const { start, length } of spots) {
        code = code.slice(0, start * 2) + addr.slice(2).toLowerCase() + code.slice((start + length) * 2);
      }
    }
  }
  if (code.includes('__$')) throw new Error('unlinked library placeholder remains');
  return `0x${code}`;
}

export interface Deployment {
  chainId: number;
  feeToken: Hex;
  registry: Hex;
  desk: Hex;
  libraries: Record<string, Hex>;
  deployBlock: string;
  deployer: Hex;
  txs: Record<string, Hex>;
}

async function deployRaw(pub: PublicClient, wallet: WalletClient, chain: Chain, bytecode: Hex, abi: any = [], args: any[] = []) {
  const hash = await wallet.deployContract({ abi, bytecode, args, chain, account: wallet.account! });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (!r.contractAddress || r.status !== 'success') throw new Error(`deploy failed ${hash}`);
  return { address: r.contractAddress, hash, block: r.blockNumber };
}

export async function deployAll(pub: PublicClient, wallet: WalletClient, chain: Chain, feeRecipient: Hex): Promise<Deployment> {
  const txs: Record<string, Hex> = {};
  const qe = await deployRaw(pub, wallet, chain, QuoteEngineBytecode as Hex);
  txs.QuoteEngine = qe.hash;
  const da = await deployRaw(pub, wallet, chain, DeskAccountingBytecode as Hex);
  txs.DeskAccounting = da.hash;
  const libs: Record<string, Hex> = { QuoteEngine: qe.address, DeskAccounting: da.address };
  const doCode = link(DeskOrdersBytecode, DeskOrdersLinkReferences as LinkRefs, libs);
  const dor = await deployRaw(pub, wallet, chain, doCode);
  txs.DeskOrders = dor.hash;
  libs.DeskOrders = dor.address;
  const token = await deployRaw(pub, wallet, chain, TestFeeTokenBytecode as Hex, TestFeeTokenAbi);
  txs.TestFeeToken = token.hash;
  const reg = await deployRaw(pub, wallet, chain, MandateRegistryBytecode as Hex, MandateRegistryAbi, [token.address, 6, feeRecipient]);
  txs.MandateRegistry = reg.hash;
  const deskCode = link(StapleDeskBytecode, StapleDeskLinkReferences as LinkRefs, libs);
  const desk = await deployRaw(pub, wallet, chain, deskCode, StapleDeskAbi, [reg.address]);
  txs.StapleDesk = desk.hash;
  const bind = await wallet.writeContract({
    address: reg.address,
    abi: MandateRegistryAbi,
    functionName: 'bindDesk',
    args: [desk.address],
    chain,
    account: wallet.account!,
  });
  await pub.waitForTransactionReceipt({ hash: bind });
  txs.bindDesk = bind;
  return {
    chainId: chain.id,
    feeToken: token.address,
    registry: reg.address,
    desk: desk.address,
    libraries: libs,
    deployBlock: qe.block.toString(),
    deployer: wallet.account!.address,
    txs,
  };
}

export function policyArgs(p: Policy) {
  return {
    market: p.market,
    quotes: { ...p.quotes, bookRule: p.quotes.bookRule === 'JOIN' ? 1 : 0 },
    exposure: p.exposure,
    risk: p.risk,
    fees: p.fees,
    expiry: p.expiry,
  };
}

export function saveDeployment(path: string, d: Deployment) {
  writeFileSync(path, JSON.stringify(d, null, 2) + '\n');
}

export function loadDeployment(path: string): Deployment {
  return JSON.parse(readFileSync(path, 'utf8')) as Deployment;
}
