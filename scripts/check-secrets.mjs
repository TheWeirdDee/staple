import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'buffer' });
  if (result.status !== 0) throw new Error('Could not inspect Git content');
  return result.stdout;
}
const known = [];
const keys = join(root, '.secrets', 'keys.json');
if (existsSync(keys)) {
  for (const value of Object.values(JSON.parse(readFileSync(keys, 'utf8')))) {
    const key = typeof value === 'string' ? value : value.key;
    if (typeof key === 'string' && /^0x[0-9a-f]{64}$/i.test(key)) known.push(key.slice(2).toLowerCase());
  }
}
const passFile = join(root, '.secrets', 'STAPLE_KEYSTORE_PASSPHRASE.txt');
const passphrase = existsSync(passFile) ? readFileSync(passFile, 'utf8').trim() : '';
const staged = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').toString('utf8').split('\0').filter(Boolean);
const worktree = process.argv.includes('--worktree');
const tracked = process.argv.includes('--tracked') || worktree;
const paths = tracked
  ? git('ls-files', ...(worktree ? ['--cached', '--others', '--exclude-standard'] : []), '-z').toString('utf8').split('\0').filter(Boolean) : staged;
let blocked = false;
for (const path of paths) {
  const sensitivePath = /(^|\/)(\.secrets|github-secrets)(\/|$)|(^|\/)(keys\.json|keystore\.json(?:\.passphrase)?|STAPLE_KEYSTORE[^/]*|staple-credentials\.zip)$|(^|\/)\.env(?:\..*)?$/i.test(path) && !path.endsWith('.env.example');
  if (tracked && !existsSync(join(root, path))) continue;
  const content = tracked ? readFileSync(join(root, path)) : git('show', `:${path}`);
  const text = content.toString('utf8');
  const leaked = known.some((key) => text.toLowerCase().includes(key)) || (passphrase.length > 0 && text.includes(passphrase));
  if (sensitivePath || leaked) {
    console.error(`BLOCKED sensitive file or recovered credential in: ${path}`);
    blocked = true;
  }
}
if (blocked) process.exitCode = 1;
else console.log(`Secret check passed: ${paths.length} ${worktree ? 'worktree' : tracked ? 'tracked' : 'staged'} files checked. No credential values printed.`);
