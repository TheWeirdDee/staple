/**
 * Keeper process: executes contract intents on HyperCore with the owner-approved agent key, reports outcomes,
 * and recovers before any new exposure after a restart. Run under a supervisor with restart-on-failure
 * (see deploy/ and docs/runbook.md).
 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { DeskChain, elysiumTestnet } from './chain.js';
import { loadDeployment } from './deploy.js';
import { HyperliquidExchange } from './exchange.js';
import { HyperliquidClient } from './hl/client.js';
import { Keeper, defaultKeeperConfig } from './keeper.js';
import { makeRedactor } from './keystore.js';
import { EventLog, Wal } from './wal.js';

const cfg = loadConfig();
const redact = makeRedactor([cfg.operatorKey, cfg.agentKey]);
const dep = loadDeployment(cfg.deploymentPath);
const chain = new DeskChain(elysiumTestnet, cfg.rpcUrl, dep.desk, dep.registry, cfg.operatorKey);
const hl = new HyperliquidClient(cfg.network, cfg.agentKey);
const ex = new HyperliquidExchange(hl, cfg.ownerAccount, cfg.market);
const wal = new Wal(join(cfg.stateDir, `wal-${cfg.mandateId}.json`));
const log = new EventLog(join(cfg.stateDir, `keeper-events-${cfg.mandateId}.jsonl`));
const keeper = new Keeper(defaultKeeperConfig(cfg.mandateId, cfg.market), chain, ex, wal, log);

const health = { startedAt: Date.now(), lastStepAt: 0, lastOkAt: 0, consecutiveErrors: 0, lastError: '', recovered: false, steps: 0 };
let stopping = false;

async function loop() {
  while (!stopping) {
    const t0 = Date.now();
    try {
      const r = await keeper.step();
      health.lastOkAt = Date.now();
      health.consecutiveErrors = 0;
      health.recovered = r.recovered;
      if (r.placed || r.cancelsSent || r.outcomes) console.log(redact(JSON.stringify({ t: t0, ...r })));
    } catch (e) {
      health.consecutiveErrors++;
      health.lastError = redact((e as Error).message).slice(0, 500);
      log.write('step_error', { error: health.lastError });
      console.error(`step error (${health.consecutiveErrors}): ${health.lastError}`);
      // Bounded exponential backoff; the on-chain watchdog and exchange-side scheduled cancel cover the gap.
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** Math.min(health.consecutiveErrors, 5))));
    }
    health.lastStepAt = Date.now();
    health.steps++;
    const wait = cfg.tickMs - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

createServer((req, res) => {
  const stale = Date.now() - health.lastOkAt > Math.max(30_000, cfg.tickMs * 6);
  res.writeHead(stale ? 503 : 200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify({ service: 'keeper', mandateId: cfg.mandateId.toString(), ok: !stale, ...health }));
}).listen(cfg.healthPort);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopping = true;
    log.write('shutdown', { signal: sig });
    // Leave orders to the exchange-side scheduled cancel and the watcher; never cancel-and-exit silently.
    setTimeout(() => process.exit(0), 2000);
  });
}

console.log(`keeper started: mandate ${cfg.mandateId} desk ${dep.desk} account ${cfg.ownerAccount} market ${cfg.market.coin}`);
loop();
