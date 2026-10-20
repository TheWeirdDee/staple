import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const checks = [];
async function check(name, fn) {
  try { checks.push({ name, ok: true, result: await fn() }); }
  catch (error) { checks.push({ name, ok: false, error: error.message }); }
}
async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data;
}
const rpc = process.env.STAPLE_ELYSIUM_RPC || 'https://testnet-rpc.elysium.kinetiq.xyz';
await check('Elysium chain ID', async () => {
  const data = await post(rpc, { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
  if (Number(data.result) !== 99801) throw new Error('Unexpected chain ID');
  return 99801;
});
await check('Hyperliquid testnet spot metadata', async () => {
  const data = await post('https://api.hyperliquid-testnet.xyz/info', { type: 'spotMeta' });
  if (!data.universe?.length) throw new Error('No spot markets');
  return { markets: data.universe.length };
});
for (const role of ['DEPLOYER', 'OPERATOR', 'WATCHER', 'OWNER']) {
  const address = process.env[`STAPLE_${role}_ADDRESS`];
  if (!address) { checks.push({ name: `${role} balance`, ok: false, error: `Set STAPLE_${role}_ADDRESS (public address)` }); continue; }
  await check(`${role} Elysium balance`, async () => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Invalid public address');
    const data = await post(rpc, { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] });
    return { address, wei: BigInt(data.result).toString(), funded: BigInt(data.result) > 0n };
  });
  if (role === 'OWNER') await check('Owner Hyperliquid spot balances', async () => {
    const data = await post('https://api.hyperliquid-testnet.xyz/info', { type: 'spotClearinghouseState', user: address });
    const usdc = data.balances?.find((balance) => balance.coin === 'USDC');
    return { ...data, usdcBalance: usdc?.total ?? '0', funded: Number(usdc?.total ?? 0) > 0 };
  });
}
checks.push({ name: 'Keystore configured', ok: Boolean(process.env.STAPLE_KEYSTORE && existsSync(process.env.STAPLE_KEYSTORE) && process.env.STAPLE_KEYSTORE_PASSPHRASE) });
checks.push({ name: 'Deployment record exists', ok: existsSync(join(root, 'runs', 'deployment-testnet.json')) });
const report = { ranAt: new Date().toISOString(), checks };
mkdirSync(join(root, 'runs'), { recursive: true });
writeFileSync(join(root, 'runs', 'readiness.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exitCode = checks.every((c) => c.ok && c.result?.funded !== false) ? 0 : 1;
