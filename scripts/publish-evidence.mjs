// Builds web/public/evidence/index.json from committed run records. Only files under runs/ and the claim
// ledger are used; nothing is typed in by hand here, so the site cannot claim more than the records show.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const j = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const maybe = (p) => (existsSync(join(root, p)) ? j(p) : null);

const facts = j('submission-facts.json').claims;
const fact = (id) => facts.find((f) => f.id === id);
const offline = maybe('runs/offline-tests.json');
const cases = j('runs/cases.json');
const g1 = maybe('runs/g1/manifest.json');
const e2e = maybe('runs/e2e-local.json');
const dep = maybe('runs/deployment-testnet.json');
const campaigns = existsSync(join(root, 'runs'))
  ? readdirSync(join(root, 'runs')).filter((d) => d.startsWith('campaign-') && existsSync(join(root, 'runs', d, 'results.json'))).map((d) => j(`runs/${d}/results.json`))
  : [];

const offlineOk = offline && offline.suites.every((s) => s.failed === 0 && s.passed > 0);
const verified = (id) => fact(id)?.status === 'testnet-verified';
const anyCaseOnTestnet = cases.some((c) => c.status === 'testnet-verified');
const gates = [
  { id: 'G1', title: 'One real testnet place/cancel/outcome loop independently observed', status: verified('g1-live-loop') ? 'met' : 'not-met', evidence: verified('g1-live-loop') ? 'runs/g1/manifest.json' : fact('g1-live-loop').limitation },
  { id: 'G2', title: 'Reservation, precision, access-control and idempotency tests pass', status: offlineOk ? 'met' : 'not-met', evidence: offline ? `${offline.suites.reduce((a, s) => a + s.passed, 0)} offline tests passed, 0 failed at ${offline.commit.slice(0, 10)}` : 'not run' },
  { id: 'G3', title: 'Stale-data shutdown works without fresh ticks; late fills and cancel failures reconcile', status: offlineOk ? (anyCaseOnTestnet ? 'met' : 'partial') : 'not-met', evidence: 'Shown offline with real contracts on a local node and the exchange test double; not yet observed on testnet.' },
  {
    id: 'G4',
    title: 'Pause/revoke UI distinguishes requested and confirmed external outcomes',
    status: 'partial',
    evidence: e2e
      ? `Browser end-to-end ${e2e.results.filter((r) => r.ok).length}/${e2e.results.length} on a local node with the exchange test double: PAUSING shown until cancels are confirmed, then PAUSED; exit stays visibly incomplete. Not yet exercised against the testnet deployment.`
      : 'Implemented; not yet exercised in a browser.',
  },
  { id: 'G5', title: 'Public evidence contains failures, unknowns, actual duration and trust limits', status: campaigns.some((c) => c.status === 'complete') ? 'met' : 'partial', evidence: campaigns.length ? 'Campaign results with interruptions and limitations published.' : 'Evidence page and limits published; no campaign has run yet.' },
  { id: 'G6', title: 'Submission facts align with what is deployed and demonstrated', status: 'partial', evidence: 'submission-facts.json maintained; README, site and submission draft generated from it. Final alignment check pending deployment.' },
];

let commit = 'uncommitted';
try {
  commit = execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
} catch {}

const index = {
  generatedAt: new Date().toISOString(),
  commit,
  network: dep ? 'Elysium testnet (99801) + Hyperliquid testnet' : 'Hyperliquid testnet + Elysium testnet (not yet deployed)',
  market: 'PURR/USDC spot',
  account: dep?.ownerAccount,
  mandateId: dep?.featuredMandate,
  gates,
  g1: g1 ?? { status: 'pending', steps: [] },
  cases,
  campaigns,
  offline: offline?.suites ?? [],
  limitations: [
    'Testnet only. Results do not establish mainnet profitability, customer demand or production reliability.',
    'The keeper’s agent key can trade outside contract intents; the watcher detects this afterwards and cannot undo trades.',
    'Observations and outcomes are reported off-chain and signed; signatures authenticate the reporter, not the data. Elysium’s native HyperCore precompile is not yet available.',
    'Keeper, watcher and sampler run on the same hosted runner (GitHub Actions) and hand over every few hours with a short gap, covered by the on-chain watchdog and Hyperliquid’s scheduled cancel.',
    'The service-fee token on Elysium is a valueless test token (tFEE); no verified USDC funding path to Elysium testnet was available.',
    'Zero customers, partners or pilots. No independent security review. Keys are file-encrypted, not KMS-backed.',
  ],
};
mkdirSync(join(root, 'web', 'public', 'evidence'), { recursive: true });
writeFileSync(join(root, 'web', 'public', 'evidence', 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log('wrote web/public/evidence/index.json', gates.map((g) => `${g.id}:${g.status}`).join(' '));
