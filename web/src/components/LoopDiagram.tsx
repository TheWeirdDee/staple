import { motion, useReducedMotion } from 'framer-motion';

const NODES = [
  { k: '01', where: 'Elysium', title: 'Public policy', text: 'Spread, sizes, inventory bounds and shutdown triggers, versioned on-chain.' },
  { k: '02', where: 'Elysium', title: 'Contract intent', text: 'The contract computes each order and reserves worst-case exposure first.' },
  { k: '03', where: 'HyperCore', title: 'Real order', text: 'The keeper signs it with the owner-approved agent. Funds stay in the owner’s account.' },
  { k: '04', where: 'Independent', title: 'Reconciled', text: 'A separate watcher matches every order and fill to an intent and reports outcomes.' },
];

/** The execution loop as a four-step strip. Motion is decorative: content is readable from the first frame. */
export function LoopDiagram() {
  const reduce = useReducedMotion();
  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox="0 0 1000 12"
        preserveAspectRatio="none"
        aria-hidden="true"
        className="loop-line"
        style={{ position: 'absolute', left: 0, right: 0, top: 22, width: '100%', height: 12 }}
      >
        <motion.path
          d="M 6 6 H 994"
          fill="none"
          stroke="var(--ink)"
          strokeWidth="1.5"
          strokeDasharray="1 0"
          initial={reduce ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.4, ease: [0.2, 0.7, 0.2, 1] }}
        />
      </svg>
      <ol className="grid-4 loop" style={{ listStyle: 'none', margin: 0, padding: 0, position: 'relative' }}>
        {NODES.map((n, i) => (
          <motion.li
            key={n.k}
            initial={reduce ? false : { opacity: 0.4, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: reduce ? 0 : 0.2 + i * 0.18 }}
            className="stack"
          >
            <div className="row" style={{ gap: 10 }}>
              <span
                aria-hidden="true"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  background: i === 2 ? 'var(--accent)' : 'var(--ink)',
                  color: 'var(--paper)',
                  font: '500 13px var(--font-mono)',
                  position: 'relative',
                  zIndex: 1,
                }}
              >
                {n.k}
              </span>
              <span className="kicker">{n.where}</span>
            </div>
            <h3 className="h3">{n.title}</h3>
            <p className="small" style={{ margin: 0, maxWidth: 260 }}>
              {n.text}
            </p>
          </motion.li>
        ))}
      </ol>
    </div>
  );
}
