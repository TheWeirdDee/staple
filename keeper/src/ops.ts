import { fileURLToPath } from 'node:url';
/**
 * Operator CLI for the testnet deployment. Every command acts on testnet only and prints what it did, with
 * transaction hashes and exchange responses, so the run can be audited afterwards.
 *
 *   tsx src/ops.ts <command> [args]
 *
 * Keys: STAPLE_KEYSTORE + STAPLE_KEYSTORE_PASSPHRASE, or STAPLE_KEYS_JSON (local development only).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createPublicClient, createWalletClient, http, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MandateRegistryAbi, StapleDeskAbi, TestFeeTokenAbi } from '@staple/reference/abi';
import { campaignPolicy, lotsToWire, parseScaled, pxToWire, roundPx } from '@staple/reference';
import { elysiumTestnet } from './chain.js';
import { deployAll, policyArgs, saveDeployment, type Deployment } from './deploy.js';
import { HyperliquidClient } from './hl/client.js';
import { loadKeystore, writeKeystore, type KeySet } from './keystore.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEP_PATH = join(ROOT, 'runs', 'deployment-testnet.json');
const WEB_DEP_PATH = join(ROOT, 'web', 'public', 'deployment.json');
const OPS_LOG = join(ROOT, 'runs', 'ops-log.jsonl');
const MARKET = JSON.parse(readFileSync(join(ROOT, 'runs', 'market-purr-usdc-testnet.json'), 'utf8'));

function keys(): KeySet {
  if (process.env.STAPLE_KEYSTORE && existsSync(process.env.STAPLE_KEYSTORE)) {
    return loadKeystore(process.env.STAPLE_KEYSTORE, process.env.STAPLE_KEYSTORE_PASSPHRASE ?? '');
  }
  const p = process.env.STAPLE_KEYS_JSON;
  if (!p) throw new Error('set STAPLE_KEYSTORE (+ passphrase) or STAPLE_KEYS_JSON');
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  return Object.fromEntries(Object.entries(raw).map(([k, v]: [string, any]) => [k, v.key ?? v])) as KeySet;
}

const transport = http(process.env.STAPLE_ELYSIUM_RPC ?? 'https://testnet-rpc.elysium.kinetiq.xyz', { timeout: 30_000, retryCount: 3 });
const pub = createPublicClient({ chain: elysiumTestnet, transport });
const wallet = (k: Hex) => createWalletClient({ chain: elysiumTestnet, transport, account: privateKeyToAccount(k) });
const addr = (k: Hex) => privateKeyToAccount(k).address;

function log(cmd: string, data: Record<string, unknown>) {
  mkdirSync(dirname(OPS_LOG), { recursive: true });
  const line = JSON.stringify({ t: new Date().toISOString(), cmd, ...data }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  writeFileSync(OPS_LOG, line + '\n', { flag: 'a' });
  console.log(line);
}

function dep(): Deployment & Record<string, any> {
  return JSON.parse(readFileSync(DEP_PATH, 'utf8'));
}

async function write(k: Hex, address: Hex, abi: any, functionName: string, args: unknown[]) {
  const w = wallet(k);
  await pub.simulateContract({ address, abi, functionName, args, account: w.account } as any);
  const hash = await w.writeContract({ address, abi, functionName, args, chain: elysiumTestnet, account: w.account } as any);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (r.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
  return { hash, block: r.blockNumber };
}

const hlFor = (k: Hex) => new HyperliquidClient('testnet', k);

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const K = cmd === 'keystore' ? ({} as KeySet) : keys();
  switch (cmd) {
    case 'keystore': {
      // Builds the encrypted keystore used by the hosted services, with a random 256-bit passphrase.
      const src = JSON.parse(readFileSync(args[0], 'utf8'));
      const pick = Object.fromEntries(['deployer', 'operator', 'agent', 'watcher', 'guard', 'owner', 'taker'].filter((n) => src[n]).map((n) => [n, src[n].key ?? src[n]]));
      const out = args[1];
      const pass = randomBytes(32).toString('base64url');
      writeKeystore(out, pick as KeySet, pass);
      writeFileSync(`${out}.passphrase`, pass, { mode: 0o600 });
      console.log(`wrote ${out} and ${out}.passphrase (keep both out of git)`);
      break;
    }
    case 'balances': {
      for (const n of ['operator', 'watcher', 'owner', 'agent', 'guard', 'taker'] as const) {
        const a = addr(K[n]);
        const [eth, spot] = await Promise.all([
          pub.getBalance({ address: a }),
          hlFor(K[n]).spotBalances(a).catch(() => null),
        ]);
        console.log(n.padEnd(9), a, `elysium ${Number(eth) / 1e18} HYPE`, 'hypercore', spot ? JSON.stringify(spot.balances.map((b) => `${b.coin}:${b.total}`)) : 'UNAVAILABLE (lookup failed)');
        if (!spot) process.exitCode = 1;
      }
      break;
    }
    case 'fund-gas': {
      // Distributes testnet HYPE from the funded deployer to the service and owner keys.
      const src = K.deployer ?? (process.env.STAPLE_DEPLOYER_KEY as Hex);
      const amount = parseEther(args[0] ?? '0.2');
      const allowed = ['operator', 'watcher', 'owner'] as const;
      const recipients = args.length > 1 ? args.slice(1) : [...allowed];
      if (recipients.some((role) => !allowed.includes(role as typeof allowed[number]))) {
        throw new Error('fund-gas recipients must be operator, watcher or owner');
      }
      if (amount <= 0n) throw new Error('fund-gas amount must be positive');
      for (const n of [...new Set(recipients)]) {
        const hash = await wallet(src).sendTransaction({ to: addr(K[n]), value: amount, chain: elysiumTestnet, account: wallet(src).account });
        const receipt = await pub.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new Error(`fund-gas reverted: ${hash}`);
        log('fund-gas', { to: n, address: addr(K[n]), amount: args[0] ?? '0.2', tx: hash });
      }
      break;
    }
    case 'deploy': {
      const src = (K.deployer ?? process.env.STAPLE_DEPLOYER_KEY) as Hex;
      const d = await deployAll(pub as any, wallet(src) as any, elysiumTestnet, addr(src));
      const full = {
        ...d,
        market: { coin: MARKET.coin, asset: MARKET.asset, spotIndex: MARKET.spotIndex, szDecimals: MARKET.szDecimals, baseToken: MARKET.baseToken, quoteToken: MARKET.quoteToken },
        keeperAgent: addr(K.agent),
        guardAgent: addr(K.guard),
        keeperOperator: addr(K.operator),
        watcherGuardian: addr(K.watcher),
        network: 'Elysium testnet (99801) + HyperCore testnet',
      };
      saveDeployment(DEP_PATH, full as any);
      saveDeployment(WEB_DEP_PATH, full as any);
      log('deploy', full);
      break;
    }
    case 'create-mandate': {
      // --no-feature creates a test mandate without changing the one the site and hosted services follow.
      const d = dep();
      const feature = !args.includes('--no-feature');
      const hours = BigInt(args.find((a) => /^\d+$/.test(a)) ?? '96');
      const block = await pub.getBlock();
      const policy = policyArgs(campaignPolicy(block.timestamp + hours * 3600n));
      const r = await write(K.owner, d.registry, MandateRegistryAbi, 'createMandate', [policy, addr(K.operator), addr(K.watcher), addr(K.owner)]);
      const id = (await pub.readContract({ address: d.registry, abi: MandateRegistryAbi, functionName: 'mandateCount' } as any)) as bigint;
      await write(K.owner, d.feeToken, TestFeeTokenAbi, 'faucet', []);
      await write(K.owner, d.feeToken, TestFeeTokenAbi, 'approve', [d.registry, 50_000_000n]);
      const f = await write(K.owner, d.registry, MandateRegistryAbi, 'depositFees', [id, 50_000_000n]);
      if (feature) {
        d.featuredMandate = id.toString();
        d.ownerAccount = addr(K.owner);
        saveDeployment(DEP_PATH, d as any);
        saveDeployment(WEB_DEP_PATH, d as any);
      }
      log('create-mandate', { id, tx: r.hash, feeDepositTx: f.hash, expiryHours: hours, featured: feature });
      break;
    }
    case 'owner-trade': {
      // Owner buys or sells inventory directly (IOC) before activation. Not a Staple action.
      const [side, lotsS] = args;
      const isBuy = side === 'buy';
      const h = hlFor(K.owner);
      const book = await h.l2Book(MARKET.coin);
      const best = parseScaled(book.levels[isBuy ? 1 : 0][0].px, 8);
      const px = roundPx((best * (isBuy ? 10_100n : 9_900n)) / 10_000n, MARKET.szDecimals, true, isBuy);
      const r = await h.order([{ a: MARKET.asset, b: isBuy, p: pxToWire(px), s: lotsToWire(BigInt(lotsS), MARKET.szDecimals), r: false, t: { limit: { tif: 'Ioc' } } }]);
      log('owner-trade', { side, lots: lotsS, limitPx: pxToWire(px), response: r });
      break;
    }
    case 'approve-agent': {
      // Owner approves a named agent (keeper or guard) on HyperCore.
      const which = args[0] as 'keeper' | 'guard';
      const d = dep();
      const id = d.featuredMandate;
      const name = which === 'keeper' ? `staple-${id}` : `staple-guard-${id}`;
      const until = Date.now() + 30 * 86_400_000;
      const r = await hlFor(K.owner).approveAgent(addr(which === 'keeper' ? K.agent : K.guard), `${name} valid_until ${until}`, '0x66eee');
      log('approve-agent', { which, name, agent: addr(which === 'keeper' ? K.agent : K.guard), validUntil: until, response: r });
      break;
    }
    case 'revoke-agent': {
      const which = args[0] as 'keeper' | 'guard';
      const d = dep();
      const name = which === 'keeper' ? `staple-${d.featuredMandate}` : `staple-guard-${d.featuredMandate}`;
      const r = await hlFor(K.owner).approveAgent('0x0000000000000000000000000000000000000000', name, '0x66eee');
      log('revoke-agent', { which, name, response: r });
      break;
    }
    case 'agents': {
      console.log(JSON.stringify(await hlFor(K.owner).extraAgents(addr(K.owner)), null, 1));
      break;
    }
    case 'activate':
    case 'pause':
    case 'requestRevoke':
    case 'rearm':
    case 'reportAgentRevoked': {
      const d = dep();
      const id = BigInt(args[0] ?? d.featuredMandate);
      const r = await write(K.owner, d.desk, StapleDeskAbi, cmd, [id]);
      log(cmd, { id, tx: r.hash, block: r.block });
      break;
    }
    case 'send': {
      // Owner spotSend to another account, e.g. funding the labelled controlled taker.
      const [to, token, amount] = args;
      const dest = (to === 'taker' ? addr(K.taker) : to) as Hex;
      const tokenId = token === 'USDC' ? `USDC:${MARKET._quoteTokenId}` : `${MARKET.baseToken}:${MARKET._baseTokenId}`;
      const r = await hlFor(K.owner).spotSend(dest, tokenId, amount);
      log('send', { to: dest, token: tokenId, amount, response: r });
      break;
    }
    default:
      console.log('commands: keystore balances fund-gas deploy create-mandate owner-trade approve-agent revoke-agent agents activate pause requestRevoke rearm reportAgentRevoked send');
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
