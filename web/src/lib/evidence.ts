/** Shape of web/public/evidence/index.json, produced by scripts/publish-evidence.mjs from runs/. */
export interface EvidenceStep {
  label: string;
  time?: string;
  detail?: string;
  tx?: string;
  oid?: string;
  cloid?: string;
  source: 'elysium' | 'hypercore' | 'sampler' | 'watcher' | 'keeper';
}

export interface EvidenceFile {
  name: string;
  sha256: string;
  url: string;
  bytes: number;
  kind: string;
}

export interface CaseResult {
  id: string;
  name: string;
  status: 'testnet-verified' | 'offline-tested' | 'not-run' | 'failed';
  evidence: string;
  note?: string;
}

export interface Campaign {
  id: string;
  status: 'running' | 'complete' | 'aborted';
  startUtc: string;
  endUtc?: string;
  durationSec: number;
  coverage: { secondsSampled: number; missingSeconds: number; invalidSeconds: number };
  arms: Record<'on' | 'off', { validSeconds: number; atTargetSeconds: number; timeAtTarget: number | null; spreadBpsP50: number | null }>;
  improvementPctPoints: number | null;
  pnl?: Record<string, string>;
  latency?: Record<string, { n: number; p50: number; p95: number; max: number; unit: string }>;
  reconciliation?: Record<string, number>;
  takerFills?: { controlled: number; other: number };
  lossTrigger?: Record<string, string>;
  files: EvidenceFile[];
  limitations: string[];
  interruptions: { start: string; end: string; reason: string }[];
}

export interface Gate {
  id: string;
  title: string;
  status: 'met' | 'partial' | 'not-met';
  evidence: string;
}

export interface EvidenceIndex {
  generatedAt: string;
  gates: Gate[];
  commit: string;
  network: string;
  market: string;
  account?: string;
  mandateId?: string;
  g1: { status: 'pending' | 'testnet-verified'; capturedUtc?: string; steps: EvidenceStep[]; manifest?: string };
  cases: CaseResult[];
  campaigns: Campaign[];
  offline: { suite: string; passed: number; failed: number; command: string }[];
  limitations: string[];
}

let cached: Promise<EvidenceIndex | null> | null = null;
export function loadEvidence(): Promise<EvidenceIndex | null> {
  cached ??= fetch(`${import.meta.env.BASE_URL}evidence/index.json`, { cache: 'no-cache' })
    .then((r) => (r.ok ? (r.json() as Promise<EvidenceIndex>) : null))
    .catch(() => null);
  return cached;
}
