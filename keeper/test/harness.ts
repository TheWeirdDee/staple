import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MandateRegistryAbi, StapleDeskAbi, TestFeeTokenAbi } from '@staple/reference/abi';
import { campaignPolicy } from '@staple/reference';
import { DeskChain } from '../src/chain.js';
import { deployAll, policyArgs, type Deployment } from '../src/deploy.js';
import { Keeper, defaultKeeperConfig } from '../src/keeper.js';
import { EventLog, Wal } from '../src/wal.js';
import { FakeExchange } from './fake-exchange.js';

// Well-known anvil development keys (public, test only).
export const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex,
  owner: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex,
  operator: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex,
  guardian: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex,
};

export const PURR = {
  coin: 'PURR/USDC',
  asset: 10000,
  spotIndex: 0,
  szDecimals: 0,
  baseToken: 'PURR',
  quoteToken: 'USDC',
};

export interface Harness {
  node: ChildProcess;
  rpc: string;
  pub: PublicClient;
  dep: Deployment;
  id: bigint;
  fake: FakeExchange;
  chainDesk: DeskChain;
  stateDir: string;
  newKeeper(): Keeper;
  owner(fn: string, args: unknown[]): Promise<void>;
  heartbeat(): Promise<void>;
  poke(): Promise<void>;
  advance(sec: number): Promise<void>;
  live(): Promise<Awaited<ReturnType<DeskChain['liveOrders']>>>;
  runtime(): Promise<Awaited<ReturnType<DeskChain['runtime']>>>;
  close(): void;
}

export async function startHarness(port: number): Promise<Harness> {
  const node = spawn('anvil', ['--port', String(port), '--silent', '--code-size-limit', '24576'], { stdio: 'ignore' });
  const rpc = `http://127.0.0.1:${port}`;
  const chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const transport = http(rpc);
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  for (let i = 0; i < 50; i++) {
    try {
      await pub.getBlockNumber();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const test = createTestClient({ chain, transport, mode: 'anvil' });
  const wallet = (k: Hex) => createWalletClient({ chain, transport, account: privateKeyToAccount(k) });
  const dep = await deployAll(pub, wallet(KEYS.deployer), chain, privateKeyToAccount(KEYS.deployer).address);

  const block = await pub.getBlock();
  const fake = new FakeExchange();
  fake.now = Number(block.timestamp) * 1000;
  fake.bookTime = fake.now;

  const ownerW = wallet(KEYS.owner);
  const ownerAddr = ownerW.account.address;
  const send = async (w: ReturnType<typeof wallet>, address: Hex, abi: any, functionName: string, args: unknown[]) => {
    const hash = await w.writeContract({ address, abi, functionName, args, chain, account: w.account } as any);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${functionName} reverted`);
  };
  const policy = policyArgs(campaignPolicy(block.timestamp + 86_400n));
  await send(ownerW, dep.registry, MandateRegistryAbi, 'createMandate', [
    policy,
    privateKeyToAccount(KEYS.operator).address,
    privateKeyToAccount(KEYS.guardian).address,
    ownerAddr,
  ]);
  const id = 1n;
  await send(ownerW, dep.feeToken, TestFeeTokenAbi, 'faucet', []);
  await send(ownerW, dep.feeToken, TestFeeTokenAbi, 'approve', [dep.registry, 2n ** 255n]);
  await send(ownerW, dep.registry, MandateRegistryAbi, 'depositFees', [id, 50_000_000n]);

  const chainDesk = new DeskChain(chain, rpc, dep.desk, dep.registry, KEYS.operator);
  const stateDir = mkdtempSync(join(tmpdir(), 'staple-keeper-'));
  const sync = async () => {
    const b = await pub.getBlock();
    fake.now = Math.max(fake.now, Number(b.timestamp) * 1000);
  };
  const h: Harness = {
    node,
    rpc,
    pub,
    dep,
    id,
    fake,
    chainDesk,
    stateDir,
    newKeeper: () => {
      const cfg = defaultKeeperConfig(id, PURR);
      return new Keeper(cfg, chainDesk, fake, new Wal(join(stateDir, 'wal.json')), new EventLog(join(stateDir, 'events.jsonl')), () => fake.now);
    },
    owner: (fn, args) => send(ownerW, dep.desk, StapleDeskAbi, fn, args),
    heartbeat: () => send(wallet(KEYS.guardian), dep.desk, StapleDeskAbi, 'heartbeat', [id]),
    poke: () => send(wallet(KEYS.guardian), dep.desk, StapleDeskAbi, 'poke', [id]),
    advance: async (sec) => {
      await test.increaseTime({ seconds: sec });
      await test.mine({ blocks: 1 });
      fake.now += sec * 1000;
      await sync();
    },
    live: () => chainDesk.liveOrders(id),
    runtime: () => chainDesk.runtime(id),
    close: () => node.kill(),
  };
  return h;
}
