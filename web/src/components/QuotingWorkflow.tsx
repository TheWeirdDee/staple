import { useEffect, useRef, useState } from 'react';
import { useInView, useReducedMotion } from 'framer-motion';
const phases = [
  'Rules published',
  'Quotes placed',
  'Execution checked',
  'Cancelling quotes',
  'Quotes withdrawn',
];
/** Deterministic explanation only. No account data, transaction IDs or performance claims. */
export function QuotingWorkflow() {
  const ref = useRef<HTMLDivElement>(null),
    visible = useInView(ref, { amount: 0.2 });
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState(0),
    [playing, setPlaying] = useState(true),
    [pageVisible, setPageVisible] = useState(!document.hidden);
  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => {
    if (!visible || !playing || reduce || !pageVisible) return;
    const timer = window.setInterval(
      () => setPhase((p) => (p + 1) % phases.length),
      3200
    );
    return () => window.clearInterval(timer);
  }, [visible, playing, reduce, pageVisible]);
  useEffect(() => {
    if (reduce) setPhase(2);
  }, [reduce]);
  const current = phase,
    resting = current === 1 || current === 2 || current === 3;
  return (
    <div
      ref={ref}
      className={`lp-workflow lp-phase-${current}`}
      aria-label="Illustrative workflow, not a live trading account"
    >
      <h2 className="visually-hidden">An illustrative quoting workflow</h2>
      <div className="lp-workflow-top">
        <span>
          <span className="lp-workflow-symbol" aria-hidden="true">
            &#8745;
          </span>{' '}
          THE QUOTING DESK
        </span>
        <div>
          <span className="lp-example-label">Illustrative workflow</span>
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            aria-label={
              reduce
                ? 'Animation disabled by reduced motion preference'
                : playing
                  ? 'Pause workflow animation'
                  : 'Play workflow animation'
            }
            disabled={!!reduce}
          >
            {reduce ? 'Static view' : playing ? 'Pause' : 'Play'}
          </button>
        </div>
      </div>
      <div className="lp-desk-grid">
        <div className="lp-desk-policy">
          <p className="lp-desk-label">01 / Your published rules</p>
          <div className="lp-account-icon" aria-hidden="true">
            &#9635;
          </div>
          <h3>Your Hyperliquid account</h3>
          <p>Trading capital stays here.</p>
          <dl>
            <div>
              <dt>Target spread</dt>
              <dd>38 bps</dd>
            </div>
            <div>
              <dt>Size per level</dt>
              <dd>20 tokens</dd>
            </div>
            <div>
              <dt>Levels per side</dt>
              <dd>3</dd>
            </div>
          </dl>
          <div className="lp-rule-link">
            <span aria-hidden="true">&#8627;</span> Rules calculate these orders
          </div>
        </div>
        <div className="lp-orderbook">
          <div className="lp-book-heading">
            <strong>TOKEN / USDC</strong>
            <span>02 / Example spot market</span>
          </div>
          <div className="lp-book-columns">
            <span>Price (USDC)</span>
            <span>Size (tokens)</span>
            <span>Side</span>
          </div>
          <div className={`lp-levels ${resting ? 'lp-levels-visible' : ''}`}>
            {['1.0039', '1.0029', '1.0019'].map((price, i) => (
              <div key={price} className="lp-level lp-sell">
                <i style={{ width: `${86 - i * 22}%` }} />
                <span>{price}</span>
                <span>{resting ? '20' : '\u2014'}</span>
                <span>{resting ? 'Sell' : '\u2014'}</span>
              </div>
            ))}
            <div className="lp-book-mid">
              <strong>
                1.0000 <small>reference price</small>
              </strong>
              <span>38 bps gap</span>
            </div>
            {['0.9981', '0.9971', '0.9961'].map((price, i) => (
              <div key={price} className="lp-level lp-buy">
                <i style={{ width: `${42 + i * 22}%` }} />
                <span>{price}</span>
                <span>{resting ? '20' : '\u2014'}</span>
                <span>{resting ? 'Buy' : '\u2014'}</span>
              </div>
            ))}
          </div>
          <p className="lp-book-caption">
            {current === 4
              ? 'Cancellation confirmed in this illustration.'
              : current === 3
                ? 'Cancel requested. Orders can still fill.'
                : 'Illustrative prices and sizes. No actual orders.'}
          </p>
        </div>
        <div className="lp-desk-check">
          <p className="lp-desk-label">03 / Independent watcher</p>
          <span
            className={`lp-check-symbol ${current === 2 ? 'lp-check-active' : ''}`}
            aria-hidden="true"
          >
            {current === 3 ? '\u2198' : current === 4 ? '\u2161' : '\u2713'}
          </span>
          <h3>
            {current === 2
              ? 'Compare the execution.'
              : current === 3
                ? 'Wait for confirmation.'
                : current === 4
                  ? 'Orders gone. Tokens stay.'
                  : 'Follow every order.'}
          </h3>
          <p>
            {current === 3
              ? 'A request is not a confirmed cancellation.'
              : current === 4
                ? 'Remaining inventory still has market risk.'
                : 'Match exchange activity to the published instructions.'}
          </p>
          <div className="lp-check-row">
            <span>Published instructions</span>
            <b>&#8594;</b>
          </div>
          <div className="lp-check-row">
            <span>Exchange orders &amp; fills</span>
            <b>&#8592;</b>
          </div>
          <div className="lp-check-note">
            {current === 2
              ? 'Example: orders match the instructions.'
              : 'Deviations are detected after execution.'}
          </div>
        </div>
      </div>
      <div className="lp-workflow-bottom">
        <span className="lp-phase-label">
          <i />
          {phases[current]}
        </span>
        <div role="group" aria-label="Workflow steps">
          {phases.map((label, i) => (
            <button
              key={label}
              type="button"
              aria-label={`Show ${label.toLowerCase()}`}
              aria-pressed={current === i}
              onClick={() => {
                setPhase(i);
                setPlaying(false);
              }}
            >
              <span />
            </button>
          ))}
        </div>
        <span className="lp-demo-only">
          Explanation only &middot; no funds connected
        </span>
      </div>
    </div>
  );
}
