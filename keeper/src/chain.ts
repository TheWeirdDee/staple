import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { MandateRegistryAbi, StapleDeskAbi } from '@staple/reference/abi';
import {
  Halt,
  MandateState,
  OrderState,
  type ChainOrder,
  type Observation,
  type Outcome,
  type Runtime,
} from './types.js';

export const elysiumTestnet = defineChain({
  id: 99801,
  name: 'Elysium Testnet',
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.elysium.kinetiq.xyz'] } },
  blockExplorers: { default: { name: 'Elysium Explorer', url: 'https://elysium.kinetiq.xyz/testnet-explorer' } },
});

const OUTCOME_TUPLE = {
  type: 'tuple[]',
  components: [
    { name: 'cloid', type: 'uint128' },
    { name: 'kind', type: 'uint8' },
    { name: 'oid', type: 'uint64' },
    { name: 'fillId', type: 'uint64' },
    { name: 'szLots', type: 'uint64' },
    { name: 'pxE8', type: 'uint64' },
    { name: 'feeE8', type: 'uint128' },
    { name: 'timeMs', type: 'uint64' },
  ],
} as const;

export interface DeskPort {
  runtime(id: bigint): Promise<Runtime>;
  liveOrders(id: bigint): Promise<ChainOrder[]>;
  accounting(id: bigint): Promise<{ snapshotTaken: boolean; expBaseE8: bigint; expQuoteE8: bigint }>;
  fillSeen(id: bigint, fillId: bigint): Promise<boolean>;
  submitTick(o: Observation): Promise<{ hash: Hex; block: bigint }>;
  submitOutcomes(id: bigint, batchSeq: bigint, outs: Outcome[]): Promise<{ hash: Hex; block: bigint }>;
  poke(id: bigint): Promise<{ hash: Hex; block: bigint }>;
}

export class DeskChain implements DeskPort {
  readonly pub: PublicClient;
  readonly wallet: WalletClient;
  readonly account: PrivateKeyAccount;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    readonly chain: Chain,
    rpcUrl: string,
    readonly desk: Hex,
    readonly registry: Hex,
    operatorKey: Hex,
  ) {
    this.account = privateKeyToAccount(operatorKey);
    const transport = http(rpcUrl, { timeout: 15_000, retryCount: 2 });
    this.pub = createPublicClient({ chain, transport }) as PublicClient;
    this.wallet = createWalletClient({ chain, transport, account: this.account });
  }

  async runtime(id: bigint): Promise<Runtime> {
    const r: any = await this.pub.readContract({ address: this.desk, abi: StapleDeskAbi, functionName: 'runtime', args: [id] });
    return {
      state: MandateState[r.state],
      halt: Halt[r.halt],
      activeVersion: Number(r.activeVersion),
      activatedAt: r.activatedAt,
      lastSeq: r.lastSeq,
      lastSourceTimeMs: r.lastSourceTimeMs,
      lastObsAt: r.lastObsAt,
      lastOutcomeSeq: r.lastOutcomeSeq,
      lastWatcherBeat: r.lastWatcherBeat,
    };
  }

  async liveOrders(id: bigint): Promise<ChainOrder[]> {
    const cloids = (await this.pub.readContract({
      address: this.desk,
      abi: StapleDeskAbi,
      functionName: 'liveCloids',
      args: [id],
    })) as bigint[];
    const out: ChainOrder[] = [];
    for (const cloid of cloids) out.push(await this.order(cloid));
    return out;
  }

  async order(cloid: bigint): Promise<ChainOrder> {
    const o: any = await this.pub.readContract({ address: this.desk, abi: StapleDeskAbi, functionName: 'getOrder', args: [cloid] });
    return {
      cloid,
      mandateId: o.mandateId,
      version: Number(o.version),
      isBuy: o.isBuy,
      state: OrderState[o.state],
      pxE8: o.pxE8,
      szLots: o.szLots,
      filledLots: o.filledLots,
      oid: o.oid,
      emittedAt: o.emittedAt,
      cancelRequestedAt: o.cancelRequestedAt,
      level: Number(o.level),
    };
  }

  async accounting(id: bigint) {
    const a: any = await this.pub.readContract({ address: this.desk, abi: StapleDeskAbi, functionName: 'getAccounting', args: [id] });
    return { snapshotTaken: a.snapshotTaken as boolean, expBaseE8: a.expBaseE8 as bigint, expQuoteE8: a.expQuoteE8 as bigint };
  }

  async fillSeen(id: bigint, fillId: bigint) {
    return (await this.pub.readContract({
      address: this.desk,
      abi: StapleDeskAbi,
      functionName: 'fillSeen',
      args: [id, fillId],
    })) as boolean;
  }

  private domain() {
    return { name: 'Staple', version: '1', chainId: this.chain.id, verifyingContract: this.desk } as const;
  }

  async signObservation(o: Observation): Promise<Hex> {
    return this.account.signTypedData({
      domain: this.domain(),
      types: {
        Observation: [
          { name: 'mandateId', type: 'uint256' },
          { name: 'seq', type: 'uint64' },
          { name: 'sourceTimeMs', type: 'uint64' },
          { name: 'bestBidE8', type: 'uint64' },
          { name: 'bestAskE8', type: 'uint64' },
          { name: 'extBidDepthLots', type: 'uint64' },
          { name: 'extAskDepthLots', type: 'uint64' },
          { name: 'markE8', type: 'uint64' },
          { name: 'baseBalE8', type: 'uint128' },
          { name: 'quoteBalE8', type: 'uint128' },
          { name: 'unreportedFills', type: 'uint32' },
        ],
      },
      primaryType: 'Observation',
      message: o,
    });
  }

  static outcomesHash(outs: Outcome[]): Hex {
    return keccak256(encodeAbiParameters([OUTCOME_TUPLE], [outs.map((o) => ({ ...o, kind: o.kind as number }))]));
  }

  async signOutcomes(id: bigint, batchSeq: bigint, outs: Outcome[]): Promise<Hex> {
    return this.account.signTypedData({
      domain: this.domain(),
      types: {
        OutcomeBatch: [
          { name: 'mandateId', type: 'uint256' },
          { name: 'batchSeq', type: 'uint64' },
          { name: 'outcomesHash', type: 'bytes32' },
        ],
      },
      primaryType: 'OutcomeBatch',
      message: { mandateId: id, batchSeq, outcomesHash: DeskChain.outcomesHash(outs) },
    });
  }

  /** Transactions from one operator key are serialised so nonces never collide. */
  private send(fn: () => Promise<Hex>): Promise<{ hash: Hex; block: bigint }> {
    const run = this.pending.then(async () => {
      const hash = await fn();
      const rcpt = await this.pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
      if (rcpt.status !== 'success') throw new Error(`tx reverted: ${hash} ${await this.revertReason(hash)}`);
      return { hash, block: rcpt.blockNumber };
    });
    this.pending = run.catch(() => undefined);
    return run;
  }

  /** Replays a failed transaction as a call at its block to recover the custom error name. */
  private async revertReason(hash: Hex): Promise<string> {
    try {
      const tx = await this.pub.getTransaction({ hash });
      await this.pub.call({ to: tx.to!, data: tx.input, account: tx.from, blockNumber: tx.blockNumber! - 1n });
      const r = await this.pub.getTransactionReceipt({ hash });
      return `(no revert on replay; gas limit ${tx.gas}, used ${r.gasUsed})`;
    } catch (e: any) {
      const data = e?.cause?.data ?? e?.data;
      try {
        if (data) {
          const { decodeErrorResult } = await import('viem');
          const d = decodeErrorResult({ abi: StapleDeskAbi as any, data });
          return `${d.errorName}(${(d.args ?? []).join(',')})`;
        }
      } catch {
        /* fall through */
      }
      return String(e?.shortMessage ?? e?.message ?? e).slice(0, 200);
    }
  }

  /**
   * Fixed gas limits sized for the bounded worst case (24 live orders, 10 placements, 16 outcomes). Estimates
   * are unreliable here: the branch a tick takes depends on block.timestamp, so an estimate taken one block
   * earlier can follow a far cheaper path (measured: ~44k vs ~690k). Unused gas is not charged.
   */
  static readonly GAS = { tick: 4_000_000n, reportOutcomes: 3_000_000n, poke: 2_500_000n } as const;

  private async writeDesk(functionName: 'tick' | 'reportOutcomes' | 'poke', args: unknown[]): Promise<Hex> {
    const req = { address: this.desk, abi: StapleDeskAbi, functionName, args, account: this.account } as any;
    // Surface genuine reverts (custom errors) before sending, using the full gas allowance.
    await this.pub.simulateContract({ ...req, gas: DeskChain.GAS[functionName] });
    return this.wallet.writeContract({ ...req, chain: this.chain, gas: DeskChain.GAS[functionName] });
  }

  submitTick(o: Observation) {
    return this.send(async () => this.writeDesk('tick', [o, await this.signObservation(o)]));
  }

  submitOutcomes(id: bigint, batchSeq: bigint, outs: Outcome[]) {
    return this.send(async () =>
      this.writeDesk('reportOutcomes', [
        id,
        batchSeq,
        outs.map((o) => ({ ...o, kind: o.kind as number })),
        await this.signOutcomes(id, batchSeq, outs),
      ]),
    );
  }

  poke(id: bigint) {
    return this.send(() => this.writeDesk('poke', [id]));
  }

  async registryIdentity(id: bigint) {
    return (await this.pub.readContract({
      address: this.registry,
      abi: MandateRegistryAbi,
      functionName: 'identity',
      args: [id],
    })) as any;
  }
}
