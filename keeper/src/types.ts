import type { Hex } from 'viem';

/** Mirrors the on-chain enums (contracts/src/StapleTypes.sol). */
export const MandateState = [
  'DRAFT',
  'ACTIVE',
  'PAUSING',
  'PAUSED',
  'TRIPPED',
  'REVOKING',
  'REVOKED',
  'EXPIRING',
  'EXPIRED',
  'RECONCILIATION_REQUIRED',
] as const;
export const Halt = ['NONE', 'STALE', 'VOLATILITY', 'FEES', 'WATCHER', 'UNRECONCILED', 'VERSION_SWITCH'] as const;
export const OrderState = [
  'NONE',
  'INTENT_EMITTED',
  'SUBMISSION_UNKNOWN',
  'ACKNOWLEDGED',
  'RESTING',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELLED',
  'REJECTED',
] as const;
export enum OutcomeKind {
  NONE = 0,
  ACK_RESTING = 1,
  SUBMISSION_UNKNOWN = 2,
  REJECTED = 3,
  FILL = 4,
  CANCEL_CONFIRMED = 5,
  CANCEL_REJECTED = 6,
}
export const REASONS: Record<number, string> = {
  1: 'QUOTED',
  2: 'HEALTHY_STAY_OUT',
  3: 'HEALTHY_JOIN',
  4: 'STALE_REFERENCE',
  5: 'DEVIATION',
  6: 'VOLATILITY',
  7: 'LOSS_TRIGGER',
  8: 'FEES_EXHAUSTED',
  9: 'UNRECONCILED_BALANCE',
  10: 'MISSING_OUTCOME',
  11: 'WATCHER_STALE',
  12: 'EXPIRY',
  13: 'OWNER_PAUSE',
  14: 'OWNER_REVOKE',
  15: 'REQUOTE',
  16: 'MISMATCH',
  17: 'VERSION_SWITCH',
  18: 'NO_BOOK',
  19: 'WAITING_RECONCILE',
  20: 'CANCEL_RETRY',
};

export interface ChainOrder {
  cloid: bigint;
  mandateId: bigint;
  version: number;
  isBuy: boolean;
  state: (typeof OrderState)[number];
  pxE8: bigint;
  szLots: bigint;
  filledLots: bigint;
  oid: bigint;
  emittedAt: bigint;
  cancelRequestedAt: bigint;
  level: number;
}

export interface Runtime {
  state: (typeof MandateState)[number];
  halt: (typeof Halt)[number];
  activeVersion: number;
  activatedAt: bigint;
  lastSeq: bigint;
  lastSourceTimeMs: bigint;
  lastObsAt: bigint;
  lastOutcomeSeq: bigint;
  lastWatcherBeat: bigint;
}

export interface Observation {
  mandateId: bigint;
  seq: bigint;
  sourceTimeMs: bigint;
  bestBidE8: bigint;
  bestAskE8: bigint;
  extBidDepthLots: bigint;
  extAskDepthLots: bigint;
  markE8: bigint;
  baseBalE8: bigint;
  quoteBalE8: bigint;
  unreportedFills: number;
}

export interface Outcome {
  cloid: bigint;
  kind: OutcomeKind;
  oid: bigint;
  fillId: bigint;
  szLots: bigint;
  pxE8: bigint;
  feeE8: bigint;
  timeMs: bigint;
}

export const cloidHex = (c: bigint): Hex => `0x${c.toString(16).padStart(32, '0')}` as Hex;
export const terminal = (s: ChainOrder['state']) => s === 'FILLED' || s === 'CANCELLED' || s === 'REJECTED';
