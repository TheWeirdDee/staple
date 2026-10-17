/**
 * Browser end-to-end test of the owner flows against REAL contracts on a local node, with the real keeper driving
 * the exchange TEST DOUBLE. The wallet is an injected EIP-1193 shim forwarding to the node's unlocked dev account.
 * Hyperliquid reads/writes from the browser go to the real Hyperliquid testnet (the dev account is unfunded there,
 * which exercises the error path of the agent approval).
 *
 *   npx tsx web/e2e/owner-flow.ts
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { StapleDeskAbi } from '@staple/reference/abi';
import { DeskChain } from '../../keeper/src/chain.js';
import { deployAll } from '../../keeper/src/deploy.js';
import { Keeper, defaultKeeperConfig } from '../../keeper/src/keeper.js';
import { EventLog, Wal } from '../../keeper/src/wal.js';
import { FakeExchange } from '../../keeper/test/fake-exchange.js';
import { KEYS, PURR } from '../../keeper/test/harness.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = process.env.E2E_OUT ?? join(ROOT, 'web', 'e2e', 'out');
const PORT = 18999;
const WEB = 5199;
const RPC = `http://127.0.0.1:${PORT}`;
const depFile = join(ROOT, 'web', 'public', 'deployment.json');
const results: { step: string; ok: boolean; detail?: string }[] = [];
const check = (step: string, ok: boolean, detail?: string) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`);
};

async function waitFor(fn: () => Promise<boolean>, ms = 30_000, every = 300) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, every));
  }
  return false;
}

async function main() {
  if (existsSync(depFile)) throw new Error('web/public/deployment.json exists; refusing to overwrite a real deployment record');
  mkdirSync(OUT, { recursive: true });
  const node = spawn('anvil', ['--port', String(PORT), '--silent', '--code-size-limit', '24576'], { stdio: 'ignore' });
  const chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const pub = createPublicClient({ chain, transport: http(RPC) });
  await waitFor(async () => (await pub.getBlockNumber()) >= 0n);
  const test = createTestClient({ chain, transport: http(RPC), mode: 'anvil' });
  const owner = privateKeyToAccount(KEYS.owner).address;
  const dep = await deployAll(pub as any, createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(KEYS.deployer) }) as any, chain, owner);
  writeFileSync(
    depFile,
    JSON.stringify({
      ...dep,
      market: { coin: 'PURR/USDC', asset: 10000, spotIndex: 0, szDecimals: 0, baseToken: 'PURR', quoteToken: 'USDC' },
      keeperAgent: privateKeyToAccount(`0x${'42'.repeat(32)}`).address,
      keeperOperator: privateKeyToAccount(KEYS.operator).address,
      watcherGuardian: privateKeyToAccount(KEYS.guardian).address,
      featuredMandate: '1',
    }),
  );
  const web = spawn('npx', ['vite', '--port', String(WEB), '--strictPort'], {
    cwd: join(ROOT, 'web'),
    env: { ...process.env, VITE_STAPLE_RPC: RPC, VITE_STAPLE_CHAIN_ID: '31337' },
    stdio: 'ignore',
  });
  const base = `http://localhost:${WEB}/staple/`;
  await waitFor(async () => (await fetch(base)).ok, 30_000);

  // Route only https through the session proxy (external APIs); the local node and dev server stay direct.
  const proxyHost = process.env.HTTPS_PROXY?.replace(/^https?:\/\//, '');
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: proxyHost ? [`--proxy-server=https=${proxyHost}`] : [],
  });
  const errors: string[] = [];
  try {
    for (const width of [390, 1440]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      // Plain-string init script: the transpiler's helpers do not exist inside the page.
      await ctx.addInitScript(`(() => {
        let id = 0;
        const rpc = ${JSON.stringify(RPC)};
        const acct = ${JSON.stringify(owner)};
        window.ethereum = {
          isStapleTestShim: true,
          on() {},
          removeListener() {},
          async request({ method, params }) {
            // Like a real wallet, authorisation survives reloads (eth_accounts returns the account once connected).
            if (method === 'eth_requestAccounts') { sessionStorage.setItem('shimConnected', '1'); return [acct]; }
            if (method === 'eth_accounts') return sessionStorage.getItem('shimConnected') ? [acct] : [];
            if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
            const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params || [] }) });
            const j = await r.json();
            if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; }
            return j.result;
          },
        };
      })();`);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(`[${width}] ${e.message}`));
      page.on('console', (m) => m.type() === 'error' && !/Hyperliquid|api\.hyperliquid|Failed to load resource/.test(m.text()) && errors.push(`[${width}] ${m.text()}`));
      if (width === 390) await ownerFlow(page, base, pub, test, dep, width);
      else await readOnlyChecks(page, base, width);
      await ctx.close();
    }
  } finally {
    await browser.close();
    web.kill();
    node.kill();
    rmSync(depFile, { force: true });
  }
  check('no uncaught page errors or app console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

/** Waits for an element to become visible (isVisible() alone does not wait). */
async function visible(loc: ReturnType<Page['getByText']>, ms: number) {
  return loc.first().waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}

async function noOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
}

async function ownerFlow(page: Page, base: string, pub: any, test: any, dep: any, width: number) {
  await page.goto(`${base}#/console`);
  await page.getByRole('button', { name: /Connect wallet/ }).click();
  check('wallet connects through the injected provider', await visible(page.getByText('Draft the public rules.'), 15_000));
  check(`no horizontal overflow on console at ${width}px`, await noOverflow(page));

  // Validation: requote threshold must be below the spread. Typing must not lose other inputs.
  await page.getByLabel(/Requote threshold/).fill('60');
  await page.getByRole('button', { name: /Publish draft mandate/ }).click();
  check('invalid draft shows a field-level explanation', await visible(page.getByText('The requote threshold must be smaller than the spread.'), 10_000));
  await shot(page, `console-validation-${width}`);
  await page.getByLabel(/Requote threshold/).fill('10');
  await page.reload();
  check('draft persists across reload', (await page.getByLabel(/Requote threshold/).inputValue()) === '10');

  await page.getByRole('button', { name: /Publish draft mandate/ }).click();
  check('publishing navigates to the new mandate', await page.waitForURL(/#\/console\/1$/, { timeout: 30_000 }).then(() => true).catch(() => false));
  check('new mandate starts as DRAFT', await visible(page.getByText('Published but not quoting.'), 15_000));

  await page.getByRole('button', { name: 'Get 100 test tFEE' }).click();
  await waitFor(async () => !(await page.getByRole('button', { name: 'Deposit 20 tFEE' }).isDisabled()));
  await page.getByRole('button', { name: 'Deposit 20 tFEE' }).click();
  check('fee deposit confirmed on-chain', await waitFor(async () => (await page.getByText(/Balance on this mandate: 20\.00/).count()) > 0, 30_000));

  // Agent approval goes to the real Hyperliquid testnet with an unfunded dev account: it must fail visibly.
  await page.getByLabel(/I understand the agent can trade/).check();
  await page.getByRole('button', { name: /Sign approval/ }).click();
  check('rejected Hyperliquid approval shows an actionable error', await visible(page.getByText(/Hyperliquid rejected the request|Hyperliquid did not answer|Could not reach Hyperliquid/), 30_000));
  await shot(page, `console-approval-error-${width}`);

  await page.getByRole('button', { name: /Activate mandate/ }).click();
  check('activation confirmed', await visible(page.getByText('Quoting under the active policy version.'), 30_000));

  // Keeper (real code) against the exchange test double produces live orders.
  const fake = new FakeExchange();
  fake.now = Number((await pub.getBlock()).timestamp) * 1000;
  fake.bookTime = fake.now;
  const desk = new DeskChain(pub.chain ?? (undefined as any), RPC, dep.desk, dep.registry, KEYS.operator);
  const dir = join(OUT, 'keeper-state');
  rmSync(dir, { recursive: true, force: true });
  const keeper = new Keeper(defaultKeeperConfig(1n, PURR), desk, fake, new Wal(join(dir, 'wal.json')), new EventLog(join(dir, 'ev.jsonl')), () => fake.now);
  const guardian = createWalletClient({ chain: pub.chain, transport: http(RPC), account: privateKeyToAccount(KEYS.guardian) });
  const hb = async () => pub.waitForTransactionReceipt({ hash: await guardian.writeContract({ address: dep.desk, abi: StapleDeskAbi, functionName: 'heartbeat', args: [1n], chain: pub.chain, account: guardian.account } as any) });
  await hb();
  await keeper.step();
  await keeper.step();
  check('keeper placed the contract intents', fake.orders.size === 4, `${fake.orders.size} orders on the exchange double`);

  await page.goto(`${base}#/mandate/1`);
  check('public page lists the live intents', await waitFor(async () => (await page.getByText(/All live intents \(4\)/).count()) > 0, 30_000));
  check(`no horizontal overflow on mandate page at ${width}px`, await noOverflow(page));
  check('latest on-chain decision explains the book on first load', await visible(page.getByText(/Latest decision/), 15_000));
  await shot(page, `mandate-active-${width}`);

  // Pause with delayed exchange cancels: UI must show PAUSING (requested) until the cancels are confirmed.
  await page.goto(`${base}#/console/1`);
  fake.delayCancels = 4;
  await page.getByRole('button', { name: /Pause and cancel orders/ }).click();
  check('pause shows requested, not complete', await visible(page.getByText(/awaiting confirmed cancellation/), 30_000));
  await keeper.step();
  check('still pausing while the exchange has not confirmed', await visible(page.getByText(/Pause requested\. Cancellations are not yet confirmed/), 10_000));
  await shot(page, `console-pausing-${width}`);
  fake.flushDelayedCancels([...fake.orders.values()].map((o) => o.cloid));
  await test.mine({ blocks: 1 });
  await keeper.step();
  check('paused only after confirmed cancellations', await visible(page.getByText('Every order is confirmed cancelled or filled. Not quoting.'), 30_000));
  await shot(page, `console-paused-${width}`);

  // Exit flow step 1 and residual inventory panel.
  await page.getByRole('button', { name: 'Start cancel-and-revoke' }).click();
  check('cancel-and-revoke records step 1 and keeps the exit visibly incomplete', await visible(page.getByText('Cancel-and-revoke in progress. Not complete until both orders and agent removal are confirmed.'), 30_000));
  await shot(page, `console-revoking-${width}`);
}

async function readOnlyChecks(page: Page, base: string, width: number) {
  for (const r of ['', 'mandate/1', 'proof', 'docs']) {
    await page.goto(`${base}#/${r}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);
    check(`no horizontal overflow on /${r} at ${width}px`, await noOverflow(page));
    await shot(page, `${r.replace('/', '-') || 'home'}-${width}`);
  }
  // Keyboard: skip link then primary navigation are reachable with visible focus.
  await page.goto(`${base}#/`);
  await page.keyboard.press('Tab');
  check('skip link is the first focus stop', (await page.evaluate(() => document.activeElement?.textContent)) === 'Skip to content');
}

main().catch((e) => {
  console.error(e);
  rmSync(depFile, { force: true });
  process.exit(1);
});
