import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Arrow, ExtLink, Mark } from './ui';
import { REPO } from '../lib/config';

const LINKS = [
  { to: '/mandate', label: 'Live mandate' },
  { to: '/proof', label: 'Proof' },
  { to: '/docs', label: 'Docs' },
];

export function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    setOpen(false);
    if (!loc.hash) window.scrollTo({ top: 0 });
  }, [loc.pathname, loc.hash]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <a href="#main" className="skip">
        Skip to content
      </a>
      <header className="nav">
        <div className="wrap nav-inner">
          <Link to="/" className="brand" aria-label="Staple home">
            <Mark />
            Staple
            <span className="net">Testnet</span>
          </Link>
          <button
            className="btn ghost sm menu-btn"
            aria-expanded={open}
            aria-controls="primary-nav"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Close' : 'Menu'}
          </button>
          <nav id="primary-nav" className={`nav-links ${open ? 'open' : ''}`} aria-label="Primary">
            {LINKS.map((l) => (
              <NavLink key={l.to} to={l.to}>
                {l.label}
              </NavLink>
            ))}
            <Link to="/console" className="btn primary sm" style={{ marginLeft: 8 }}>
              Owner console <Arrow />
            </Link>
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1} style={{ outline: 'none' }}>
        {children}
      </main>
      <footer className="footer">
        <div className="wrap spread">
          <div className="stack" style={{ maxWidth: 560 }}>
            <p style={{ margin: 0 }}>
              Staple is a testnet prototype on Hyperliquid testnet (HyperCore) and Elysium testnet. No real funds. Nothing
              here is investment advice or a promise of results.
            </p>
            <p style={{ margin: 0 }}>
              The contract constrains its intents; the keeper’s agent key can still trade outside them. Monitoring detects
              deviations after they happen.
            </p>
          </div>
          <div className="row" style={{ gap: 18 }}>
            <ExtLink href={REPO}>Source on GitHub</ExtLink>
            <Link to="/docs#trust">Trust boundary</Link>
            <Link to="/proof">Evidence</Link>
          </div>
        </div>
      </footer>
    </>
  );
}
