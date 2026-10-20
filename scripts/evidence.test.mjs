import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
function generate({ cases = [], suites, deployed = false, manifest = false }) {
  mkdirSync(join(root, '.test-tmp'), { recursive: true });
  const dir = mkdtempSync(join(root, '.test-tmp', 'evidence-'));
  const json = (path, value) => writeFileSync(join(dir, path), JSON.stringify(value));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'runs', 'g1'), { recursive: true });
    copyFileSync(join(root, 'scripts', 'publish-evidence.mjs'), join(dir, 'scripts', 'publish-evidence.mjs'));
    json('submission-facts.json', { claims: [{ id: 'g1-live-loop', status: 'testnet-verified', limitation: 'not run' }] });
    json('runs/cases.json', cases);
    json('runs/offline-tests.json', { commit: 'fixture', suites: suites || Array.from({ length: 5 }, () => ({ passed: 1, failed: 0, exitCode: 0 })) });
    if (deployed) json('runs/deployment-testnet.json', { chainId: 99801 });
    if (manifest) json('runs/g1/manifest.json', { status: 'testnet-verified' });
    const run = spawnSync(process.execPath, [join(dir, 'scripts', 'publish-evidence.mjs')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(readFileSync(join(dir, 'web', 'public', 'evidence', 'index.json'))).gates;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const status = (gates, id) => gates.find((gate) => gate.id === id).status;
test('an unrelated live case cannot satisfy G3', () => {
  assert.equal(status(generate({ cases: [{ id: 'activation', status: 'testnet-verified' }] }), 'G3'), 'partial');
});
test('G3 requires all three shutdown and recovery cases', () => {
  assert.equal(status(generate({ cases: ['stale', 'delayed-cancel', 'outage'].map((id) => ({ id, status: 'testnet-verified' })) }), 'G3'), 'met');
});
test('test command failure prevents G2 even with passing counters', () => {
  assert.equal(status(generate({ suites: Array.from({ length: 5 }, () => ({ passed: 1, failed: 0, exitCode: 1 })) }), 'G2'), 'not-met');
});
test('a claim alone cannot satisfy G1 without deployment and manifest', () => {
  assert.equal(status(generate({}), 'G1'), 'not-met');
  assert.equal(status(generate({ deployed: true, manifest: true }), 'G1'), 'met');
});
