import {
  motion,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
} from 'framer-motion';
import { useRef, useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { Arrow, ExtLink } from '../components/ui';
import { QuotingWorkflow } from '../components/QuotingWorkflow';
import { loadEvidence } from '../lib/evidence';
import { usePoll } from '../lib/usePoll';
import './landing.css';

const steps = [
  [
    'Set the rules.',
    'Choose the spread, order sizes, inventory bounds and shutdown conditions. A mandate is your published set of quoting rules, versioned on Elysium.',
    'Your strategy, written down.',
  ],
  [
    'Approve trading access.',
    'Authorise a trading agent for your Hyperliquid account. Your trading capital stays there. The agent can trade outside the public rules; monitoring detects this afterward.',
    'Permission is yours to give and revoke.',
  ],
  [
    'Put quotes on the book.',
    'The contract calculates intended buy and sell orders. A keeper, the service that submits them, places those orders on Hyperliquid using the approved agent.',
    'Public instructions become exchange orders.',
  ],
  [
    'Inspect what happened.',
    'A separate watcher compares actual orders and fills with the public instructions. The public page separates intended, observed and unconfirmed activity, including discrepancies.',
    'See the rules and the actual trading.',
  ],
];
const questions = [
  [
    'Who is Staple for?',
    'Token teams that already hold inventory and want to place buy and sell orders on a Hyperliquid spot market under public quoting rules. The first release targets one testnet spot market.',
  ],
  [
    'Does Staple hold my trading funds?',
    'Trading capital stays in your own Hyperliquid account. Prepaid service fees are separate: they are deposited into the fee contract on Elysium. The prototype uses a valueless test fee token, tFEE.',
  ],
  [
    'What access does the trading agent have?',
    'The approved agent can place and cancel trades. Public policy constrains the instructions Staple produces, but does not technically restrict the key to those instructions. Monitoring detects deviations after they happen and cannot undo a trade. Market observations and outcomes also depend on off-chain reporters; signatures identify the sender, not the truth of the data.',
  ],
  [
    'Can losses exceed the shutdown threshold?',
    'Yes. The threshold stops new quoting and requests cancellation; it is not a guaranteed loss cap. Detection and cancellation take time, and inventory remains exposed to market moves afterward.',
  ],
  [
    'What happens when I pause?',
    'Staple stops generating new orders and requests cancellation. The UI shows that cancellation is pending until orders are confirmed cancelled or filled. Pausing does not revoke trading access, sell your remaining tokens, or remove their price exposure. Exit also requires agent revocation and separate confirmation.',
  ],
  [
    'Is this mainnet or testnet?',
    'Testnet only. The contracts, keeper, watcher and interface have local test coverage. A real testnet trading loop and campaign have not yet been published. There are no mainnet results, customers or partners, and no independent security review. Testnet results cannot establish profitability or production reliability.',
  ],
];

function Process() {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start 0.55', 'end 0.7'],
  });
  return (
    <section
      ref={ref}
      id="how-it-works"
      tabIndex={-1}
      className="lp-section lp-process lp-width"
      aria-labelledby="process-heading"
    >
      <div className="lp-process-intro">
        <p className="lp-eyebrow">From your account to the order book</p>
        <h2 id="process-heading">
          A strategy you can follow all the way through.
        </h2>
        <p>Four steps connect what you choose with what actually happens.</p>
        <Link className="lp-text-link" to="/console">
          Draft your quoting rules <Arrow />
        </Link>
      </div>
      <div className="lp-step-sequence">
        <div className="lp-progress" aria-hidden="true">
          <motion.div style={{ scaleY: reduce ? 1 : scrollYProgress }} />
        </div>
        <ol className="lp-steps">
          {steps.map(([title, text, foot], i) => (
            <li key={title}>
              <span className="lp-step-number">0{i + 1}</span>
              <div>
                <h3>{title}</h3>
                <p>{text}</p>
                <span className="lp-step-foot">{foot}</span>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
function Controls() {
  const [spread, setSpread] = useState(38);
  const [size, setSize] = useState(20);
  return (
    <section
      id="controls"
      tabIndex={-1}
      className="lp-controls"
      aria-labelledby="controls-heading"
    >
      <div className="lp-width lp-controls-grid">
        <div className="lp-controls-copy">
          <p className="lp-eyebrow">Define the boundaries</p>
          <h2 id="controls-heading">
            Your inventory.
            <br />
            Your parameters.
          </h2>
          <p>
            Choose how much to quote, how close to the market, and when to stop
            placing new orders.
          </p>
          <div className="lp-control-note">
            <span>01</span>
            <p>
              <strong>Quote with intention.</strong> Set the gap between your
              buy and sell prices and the size at each level.
            </p>
          </div>
          <div className="lp-control-note">
            <span>02</span>
            <p>
              <strong>Bound your exposure.</strong> Set minimum and maximum
              inventory and the budget available for buy orders.
            </p>
          </div>
          <div className="lp-control-note">
            <span>03</span>
            <p>
              <strong>Know what stopping means.</strong> Stale data, volatility,
              a loss trigger or a mismatch can halt new quoting. Orders still
              need cancellation; remaining tokens keep their market risk.
            </p>
          </div>
        </div>
        <div className="lp-policy-demo">
          <div className="lp-policy-head">
            <span className="lp-mini-mark" aria-hidden="true">
              &#8745;
            </span>
            <div>
              <strong>Quoting policy</strong>
              <span>Illustrative controls &middot; no orders sent</span>
            </div>
          </div>
          <div className="lp-range-field">
            <label htmlFor="example-spread">
              Spread{' '}
              <output htmlFor="example-spread">
                {spread} bps <small>({(spread / 100).toFixed(2)}%)</small>
              </output>
            </label>
            <input
              id="example-spread"
              type="range"
              min="20"
              max="100"
              step="2"
              value={spread}
              onChange={(e) => setSpread(Number(e.target.value))}
            />
            <p>The gap between your best buy and sell prices.</p>
          </div>
          <div className="lp-range-field">
            <label htmlFor="example-size">
              Order size <output htmlFor="example-size">{size} tokens</output>
            </label>
            <input
              id="example-size"
              type="range"
              min="10"
              max="50"
              step="5"
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
            />
            <p>Tokens per order, subject to market precision and limits.</p>
          </div>
          <div className="lp-inventory">
            <span>Illustrative inventory bounds</span>
            <strong>
              10 <span>to</span> 100 tokens
            </strong>
            <div aria-hidden="true">
              <i />
              <b />
            </div>
            <p>Reservations include orders still awaiting cancellation.</p>
          </div>
          <div className="lp-shutdown">
            <span>Stop new quoting when</span>
            <p>
              <i /> Market data is stale
            </p>
            <p>
              <i /> Loss or volatility triggers
            </p>
            <p>
              <i /> Execution does not match
            </p>
          </div>
          <Link to="/console" className="lp-button lp-button-dark">
            Draft a real policy <Arrow />
          </Link>
          <p className="lp-policy-caption">
            Drafting is available. Activation needs a funded testnet deployment
            and approved trading access.
          </p>
        </div>
      </div>
    </section>
  );
}
function Evidence() {
  const { data } = usePoll(loadEvidence, 0);
  const recorded = data?.g1?.status === 'testnet-verified';
  const passed = data?.offline?.reduce((sum, s) => sum + s.passed, 0);
  const failures = data?.offline?.some((s) => s.failed > 0 || s.passed === 0);
  return (
    <section
      id="evidence"
      tabIndex={-1}
      className="lp-section lp-width lp-evidence"
      aria-labelledby="evidence-heading"
    >
      <div>
        <p className="lp-eyebrow">Show the work</p>
        <h2 id="evidence-heading">
          The rules are public.
          <br />
          So is the progress.
        </h2>
        <p>
          Inspect what has been tested, what is still pending, and the limits
          behind each claim.
        </p>
        <Link className="lp-text-link" to="/proof">
          Read the evidence <Arrow />
        </Link>
      </div>
      <div className="lp-evidence-ledger">
        <div>
          <span>Environment</span>
          <strong>Testnet prototype</strong>
        </div>
        <div>
          <span>Recorded offline tests</span>
          <strong>
            {passed
              ? `${passed} passed${failures ? ' - failures recorded' : ''}`
              : 'See published record'}
          </strong>
        </div>
        <div>
          <span>Real testnet trading loop</span>
          <strong>
            {recorded ? 'Recorded run available' : 'Not yet published'}
          </strong>
        </div>
        <p>
          {recorded
            ? `Recorded on ${data.network}. Open the evidence page for timestamps, records and limitations.`
            : 'Local tests use real contracts on a local chain and an exchange test double. They do not establish live exchange integration or trading performance.'}
        </p>
      </div>
    </section>
  );
}
export function Landing() {
  const reduce = useReducedMotion();
  const mouseX = useMotionValue(0),
    mouseY = useMotionValue(0);
  const x = useSpring(mouseX, { stiffness: 65, damping: 24 }),
    y = useSpring(mouseY, { stiffness: 65, damping: 24 });
  const parallax = (e: MouseEvent<HTMLElement>) => {
    if (reduce || !window.matchMedia('(pointer: fine)').matches) return;
    const box = e.currentTarget.getBoundingClientRect();
    mouseX.set(((e.clientX - box.left) / box.width - 0.5) * 16);
    mouseY.set(((e.clientY - box.top) / box.height - 0.5) * 16);
  };
  const rise = (delay: number) =>
    reduce
      ? {}
      : {
          initial: { y: 16, opacity: 0.35 },
          animate: { y: 0, opacity: 1 },
          transition: { duration: 0.65, delay, ease: [0.2, 0.7, 0.2, 1] },
        };
  return (
    <div className="lp">
      <section
        className="lp-hero"
        aria-labelledby="landing-heading"
        onMouseMove={parallax}
        onMouseLeave={() => {
          mouseX.set(0);
          mouseY.set(0);
        }}
      >
        <motion.div
          className="lp-hero-texture"
          aria-hidden="true"
          style={{
            x: reduce ? 0 : x,
            y: reduce ? 0 : y,
            backgroundImage: `url("${import.meta.env.BASE_URL}art/engraved-depth.svg")`,
          }}
        />
        <div className="lp-hero-copy">
          <motion.p className="lp-eyebrow" {...rise(0)}>
            Market making for token teams
          </motion.p>
          <motion.h1 id="landing-heading" {...rise(0.08)}>
            <span>Put your tokens to work.</span>
            <span>
              Keep the rules <em>public.</em>
            </span>
          </motion.h1>
          <motion.p className="lp-hero-description" {...rise(0.16)}>
            Staple places buy and sell orders on Hyperliquid from your own
            account. You choose the spread, order sizes and when quoting should
            stop. Anyone can inspect the rules and how execution follows them.
          </motion.p>
          <motion.div className="lp-hero-actions" {...rise(0.24)}>
            <Link to="/#how-it-works" className="lp-button">
              Explore how it works <Arrow />
            </Link>
            <Link to="/proof" className="lp-button lp-button-light">
              Read the evidence <Arrow />
            </Link>
          </motion.div>
          <p className="lp-environment">
            <span /> Testnet prototype &middot; trading capital stays in your
            account
          </p>
        </div>
        <motion.div className="lp-product-wrap" {...rise(0.32)}>
          <QuotingWorkflow />
        </motion.div>
        <div className="lp-hero-bottom">
          <span>Your account</span>
          <i aria-hidden="true">&#8594;</i>
          <span>Public rules</span>
          <i aria-hidden="true">&#8594;</i>
          <span>Buy &amp; sell orders</span>
          <i aria-hidden="true">&#8594;</i>
          <span>Execution checks</span>
        </div>
      </section>
      <section
        className="lp-section lp-width lp-explainer"
        aria-labelledby="explanation-heading"
      >
        <div>
          <p className="lp-eyebrow">Make room for the next trade</p>
          <h2 id="explanation-heading">
            You already hold the tokens.
            <br />
            Give them a quoting strategy.
          </h2>
        </div>
        <div>
          <p className="lp-lead">
            Market making means putting buy and sell orders on the book, so
            other people have prices and available size to trade against.
          </p>
          <p>
            Staple turns your inventory into a public quoting strategy. You set
            the terms; everyone can compare those terms with actual exchange
            activity.
          </p>
        </div>
      </section>
      <section
        className="lp-width lp-benefits"
        aria-label="What you keep control of"
      >
        <article>
          <span className="lp-benefit-icon" aria-hidden="true">
            &#8599;
          </span>
          <h3>
            Your account.
            <br />
            Your trading capital.
          </h3>
          <p>
            Trade from your own Hyperliquid account. Prepaid service fees on
            Elysium are separate from your trading inventory.
          </p>
        </article>
        <article>
          <span className="lp-benefit-icon" aria-hidden="true">
            &#8801;
          </span>
          <h3>
            Public rules.
            <br />A shared reference.
          </h3>
          <p>
            Spread, sizes and inventory bounds are published and versioned.
            Changes have a history people can read.
          </p>
        </article>
        <article>
          <span className="lp-benefit-icon" aria-hidden="true">
            &#10003;
          </span>
          <h3>
            Actual orders.
            <br />
            An independent check.
          </h3>
          <p>
            A separate watcher compares exchange orders and fills with published
            instructions. Deviations stay visible.
          </p>
        </article>
      </section>
      <Process />
      <Controls />
      <Evidence />
      <section
        className="lp-section lp-width lp-faq"
        aria-labelledby="faq-heading"
      >
        <div>
          <p className="lp-eyebrow">A few important details</p>
          <h2 id="faq-heading">
            Know what
            <br />
            you’re approving.
          </h2>
          <p>
            Public rules make trading easier to inspect. Understanding the
            permissions still matters.
          </p>
          <Link to="/docs#trust" className="lp-text-link">
            Read the trust model <Arrow />
          </Link>
        </div>
        <div className="lp-questions">
          {questions.map(([q, a]) => (
            <details key={q}>
              <summary>
                {q}
                <span aria-hidden="true">+</span>
              </summary>
              <div className="lp-answer">
                <p>{a}</p>
              </div>
            </details>
          ))}
        </div>
      </section>
      <section className="lp-final lp-width">
        <div>
          <p className="lp-eyebrow">Market making you can audit</p>
          <h2>
            Give your market a strategy
            <br />
            people can actually inspect.
          </h2>
          <p>
            Start with the workflow. See the evidence. Draft your own rules.
          </p>
        </div>
        <div>
          <Link to="/console" className="lp-button">
            Draft your quoting rules <Arrow />
          </Link>
          <Link className="lp-final-secondary" to="/proof">
            Check current readiness <Arrow />
          </Link>
        </div>
      </section>
      <div className="lp-source-note lp-width">
        Open source, from policy to execution.{' '}
        <ExtLink href="https://github.com/TheWeirdDee/staple">
          Inspect the code
        </ExtLink>
      </div>
    </div>
  );
}
