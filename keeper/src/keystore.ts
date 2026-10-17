/**
 * Encrypted key storage for server-side signing keys (scrypt + AES-256-GCM). Keys are decrypted into memory
 * only, never logged and never written to evidence. This is file encryption with a passphrase supplied by the
 * host's secret store; it is not KMS or HSM-backed.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Hex } from 'viem';

interface Envelope {
  v: 1;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

export type KeySet = Record<string, Hex>;

const N = 1 << 15;

export function encryptKeys(keys: KeySet, passphrase: string): Envelope {
  if (passphrase.length < 16) throw new Error('passphrase must be at least 16 characters');
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(keys), 'utf8'), c.final()]);
  return {
    v: 1,
    kdf: 'scrypt',
    N,
    r: 8,
    p: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

export function decryptKeys(env: Envelope, passphrase: string): KeySet {
  const key = scryptSync(passphrase, Buffer.from(env.salt, 'base64'), 32, {
    N: env.N,
    r: env.r,
    p: env.p,
    maxmem: 64 * 1024 * 1024,
  });
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  d.setAuthTag(Buffer.from(env.tag, 'base64'));
  const pt = Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]);
  return JSON.parse(pt.toString('utf8')) as KeySet;
}

export function loadKeystore(path: string, passphrase: string): KeySet {
  return decryptKeys(JSON.parse(readFileSync(path, 'utf8')) as Envelope, passphrase);
}

export function writeKeystore(path: string, keys: KeySet, passphrase: string) {
  writeFileSync(path, JSON.stringify(encryptKeys(keys, passphrase)), { mode: 0o600 });
}

/**
 * Builds a redactor for the exact secret values in use. Transaction hashes and order ids are also 32-byte hex,
 * so redaction matches the secrets themselves rather than a pattern.
 */
export function makeRedactor(secrets: string[]): (s: string) => string {
  const needles = secrets.filter(Boolean).map((k) => k.toLowerCase().replace(/^0x/, ''));
  return (s: string) => {
    let out = s;
    for (const n of needles) out = out.replace(new RegExp(`(0x)?${n}`, 'gi'), '<redacted-key>');
    return out;
  };
}
