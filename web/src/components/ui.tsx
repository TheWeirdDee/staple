import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { GLOSSARY } from '../lib/glossary';
import type { MandateStateName } from '../lib/desk';

export function Arrow() {
  return (
    <svg className="arrow" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8h9M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function External() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" style={{ display: 'inline', verticalAlign: '-1px' }}>
      <path d="M6 3H3v10h10v-3M9 3h4v4M13 3 7 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#14151a" />
      <path d="M9 23V11.5a2.5 2.5 0 0 1 2.5-2.5h9A2.5 2.5 0 0 1 23 11.5V23" fill="none" stroke="#f3f1ea" strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}

export function ExtLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={className}>
      {children} <External />
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

export function CTA({ to, children, variant = 'primary' }: { to: string; children: ReactNode; variant?: 'primary' | 'ghost' | 'dark' }) {
  return (
    <Link to={to} className={`btn ${variant === 'dark' ? '' : variant}`}>
      {children} <Arrow />
    </Link>
  );
}

/** Glossary term with an accessible popover (hover, focus or tap). */
export function Term({ k, children }: { k: string; children?: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const def = GLOSSARY[k];
  if (!def) return <>{children ?? k}</>;
  return (
    <span style={{ position: 'relative', display: 'inline' }}>
      <button
        type="button"
        className="term"
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        style={{ background: 'none', border: 0, padding: 0, font: 'inherit', color: 'inherit' }}
      >
        {children ?? k}
      </button>
      <span
        role="tooltip"
        id={id}
        style={{
          position: 'absolute',
          left: 0,
          top: '1.6em',
          zIndex: 30,
          width: 'min(300px, 80vw)',
          background: 'var(--ink)',
          color: 'var(--paper)',
          fontSize: 13.5,
          lineHeight: 1.45,
          fontWeight: 400,
          padding: '10px 12px',
          borderRadius: 8,
          boxShadow: 'var(--shadow)',
          display: open ? 'block' : 'none',
          textTransform: 'none',
          letterSpacing: 0,
          fontFamily: 'var(--font-ui)',
        }}
      >
        {def}
      </span>
    </span>
  );
}

const STATE_INFO: Record<MandateStateName, { tone: string; label: string; text: string; pending?: boolean }> = {
  DRAFT: { tone: 'info', label: 'Draft', text: 'Published but not quoting.' },
  ACTIVE: { tone: 'ok', label: 'Active', text: 'Quoting under the active policy version.' },
  PAUSING: { tone: 'warn', label: 'Pausing', text: 'Pause requested. Cancellations are not yet confirmed by the exchange.', pending: true },
  PAUSED: { tone: 'info', label: 'Paused', text: 'Every order is confirmed cancelled or filled. Not quoting.' },
  TRIPPED: { tone: 'bad', label: 'Tripped', text: 'A loss or mismatch trigger fired. No new quotes; owner must re-arm after reconciliation.' },
  REVOKING: { tone: 'warn', label: 'Revoking', text: 'Cancel-and-revoke in progress. Not complete until both orders and agent removal are confirmed.', pending: true },
  REVOKED: { tone: 'info', label: 'Revoked', text: 'Orders confirmed gone and agent removal observed on HyperCore.' },
  EXPIRING: { tone: 'warn', label: 'Expiring', text: 'Expiry reached. Cancellations requested but not all confirmed.', pending: true },
  EXPIRED: { tone: 'info', label: 'Expired', text: 'Expired with every order confirmed terminal.' },
  RECONCILIATION_REQUIRED: {
    tone: 'bad',
    label: 'Reconciliation required',
    text: 'Something on the exchange was not explained by recorded intents. No new exposure until the owner reconciles and re-arms.',
  },
};

export function StateBadge({ state, withText }: { state: MandateStateName; withText?: boolean }) {
  const s = STATE_INFO[state];
  return (
    <span className="row" style={{ gap: 10 }}>
      <span className={`badge ${s.tone} ${s.pending ? 'pending' : ''}`}>{s.label}</span>
      {withText && <span className="small">{s.text}</span>}
    </span>
  );
}
export const stateText = (s: MandateStateName) => STATE_INFO[s].text;

export function Badge({ tone, children, pending, long }: { tone: 'ok' | 'warn' | 'bad' | 'info'; children: ReactNode; pending?: boolean; long?: boolean }) {
  return <span className={`badge ${tone} ${pending ? 'pending' : ''} ${long ? 'long' : ''}`}>{children}</span>;
}

export function Stat({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

export function Notice({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'bad' | 'ok'; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`notice ${tone}`} role={tone === 'bad' ? 'alert' : undefined}>
      <span aria-hidden="true" style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
        {tone === 'bad' ? '!' : tone === 'warn' ? '△' : tone === 'ok' ? '✓' : 'i'}
      </span>
      <div>
        {title && <strong>{title}</strong>}
        {children}
      </div>
    </div>
  );
}

export function Meter({ value, max, tone, label }: { value: number; max: number; tone?: 'warn' | 'bad'; label: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={`meter ${tone ?? ''}`} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Skeleton({ h = 18, w = '100%' }: { h?: number; w?: number | string }) {
  return <div className="skeleton" style={{ height: h, width: w }} aria-hidden="true" />;
}

export function SectionHead({ kicker, title, children }: { kicker: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="stack" style={{ marginBottom: 'var(--s6)' }}>
      <p className="kicker">{kicker}</p>
      <h2 className="h2">{title}</h2>
      {children && <p className="body">{children}</p>}
    </div>
  );
}

export function LoadError({ what, error, retry }: { what: string; error: string; retry?: () => void }) {
  return (
    <Notice tone="bad" title={`Could not load ${what}`}>
      <p className="small" style={{ margin: '4px 0 8px' }}>
        {error}. Data shown elsewhere on this page may be older. Nothing about the mandate changes when a page fails to load.
      </p>
      {retry && (
        <button className="btn sm ghost" onClick={retry}>
          Try again
        </button>
      )}
    </Notice>
  );
}
