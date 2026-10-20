import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { delimiter, join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
if (process.platform === 'win32') {
  for (const tool of ['forge', 'anvil']) {
    const bin = join(root, '.tools', 'node_modules', '@foundry-rs', `${tool}-win32-amd64`, 'bin');
    if (existsSync(bin)) process.env.PATH = `${bin}${delimiter}${process.env.PATH || ''}`;
  }
}
// PowerShell/cmd shims need a shell on Windows. All command arguments below are fixed repository values.
const run = (command, args, cwd = root) => spawnSync(command, args, {
  cwd, encoding: 'utf8', timeout: 300000, shell: process.platform === 'win32' && command === 'pnpm',
  env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
});
const py = process.env.STAPLE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const definitions = [
  ['Contracts (Foundry)', 'forge', ['test'], 'contracts', 'forge'],
  ['Reference quote engine, frozen vectors, policy', 'pnpm', ['--filter', '@staple/reference', 'test'], '.', 'vitest'],
  ['Keeper: local node + exchange test double, SDK signing vectors', 'pnpm', ['--filter', '@staple/keeper', 'test'], '.', 'vitest'],
  ['Watcher reconciliation, guard signing, keystore', py, ['-m', 'pytest', 'tests', '-q', '-p', 'no:cacheprovider', '--basetemp=../.test-tmp/watcher'], 'watcher', 'pytest'],
  ['Sampler metric computation', py, ['-m', 'pytest', 'test_metrics.py', '-q', '-p', 'no:cacheprovider', '--basetemp=../.test-tmp/sampler'], 'sampler', 'pytest'],
];
const sum = (matches) => [...matches].reduce((total, m) => total + Number(m[1]), 0);
const suites = [];
mkdirSync(join(root, '.test-tmp'), { recursive: true });
for (const [suite, cmd, args, dir, kind] of definitions) {
  console.log(`\nRunning ${suite}`);
  const result = run(cmd, args, join(root, dir));
  const output = `${result.stdout || ''}${result.stderr || ''}${result.error?.message || ''}`;
  console.log(output);
  // Foundry prints both per-suite and aggregate counts: count only aggregate lines.
  const summary = kind === 'forge' ? output.split(/\r?\n/).filter((line) => /^Ran \d+ test suites?/.test(line)).join('\n')
    : kind === 'vitest' ? output.split(/\r?\n/).filter((line) => /^\s*Tests\s/.test(line)).join('\n') : output;
  const passed = sum(summary.matchAll(/(\d+)(?: tests?)? passed/g));
  const failed = sum(summary.matchAll(/(\d+) failed/g));
  suites.push({ suite, passed, failed, exitCode: result.status ?? 1,
    command: [cmd, ...args].join(' '), verified: result.status === 0 && passed > 0 && failed === 0 });
}
const git = run('git', ['rev-parse', 'HEAD']);
mkdirSync(join(root, 'runs'), { recursive: true });
const workingTree = run('git', ['status', '--porcelain']);
const report = { workingTreeDirty: workingTree.status !== 0 || workingTree.stdout.trim().length > 0, commit: git.status === 0 ? git.stdout.trim() : 'unknown', ranAt: new Date().toISOString(), suites };
const outputPath = process.env.STAPLE_OFFLINE_REPORT || join(root, 'runs', 'offline-tests.json');
writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(`Report: ${outputPath}`);
process.exitCode = suites.every((s) => s.verified) ? 0 : 1;
