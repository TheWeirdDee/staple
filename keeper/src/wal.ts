import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Keeper write-ahead state. The chain remains the source of truth for intents, reservations and ingested fills;
 * this file only records what the keeper itself sent to the exchange, so a restart can tell "never submitted"
 * apart from "submitted, outcome unknown".
 */
export interface WalState {
  version: 1;
  submissions: Record<string, { at: number; expiresAfter: number; result?: string }>; // cloid -> attempt
  cancelsSent: Record<string, number>; // cloid -> on-chain cancelRequestedAt we acted on
  lastFillPollMs: number;
  lastScheduleCancelMs: number;
  scheduleCancelAt?: number;
}

export const emptyWal = (): WalState => ({
  version: 1,
  submissions: {},
  cancelsSent: {},
  lastFillPollMs: 0,
  lastScheduleCancelMs: 0,
});

export class Wal {
  state: WalState;
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.state = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as WalState) : emptyWal();
  }
  /** Atomic write (temp file + rename) so a crash never leaves a torn state file. */
  flush() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.path);
  }
}

/** Append-only JSONL evidence log (keeper-side; never used as independent evidence). */
export class EventLog {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }
  write(kind: string, data: Record<string, unknown>) {
    const line = JSON.stringify({ t: Date.now(), kind, ...data }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    appendFileSync(this.path, line + '\n');
  }
}
