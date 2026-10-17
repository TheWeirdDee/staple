/** Plain-English definitions shown wherever trading terms appear. */
export const GLOSSARY: Record<string, string> = {
  spread: 'The gap between the best price to buy and the best price to sell. A tighter spread means cheaper trading.',
  bps: 'Basis points. 1 bps = 0.01%, so 40 bps = 0.40%.',
  ladder: 'A set of buy and sell orders at several prices, a little further from the market at each step.',
  level: 'One rung of the ladder: a single buy or sell order at one price.',
  inventory: 'How much of the token the account holds right now.',
  skew: 'Shifting all quotes slightly when inventory is above or below its baseline, so the book leans toward rebalancing.',
  reservation:
    'Capacity set aside for every order that could still execute, including ones being cancelled, so limits hold in the worst case.',
  'post-only':
    'An order that only rests on the book. If it would trade immediately it is rejected instead (exchange term: ALO).',
  fill: 'A trade: someone took one of the resting orders, fully or partly.',
  mid: 'The halfway point between the best bid and the best ask.',
  reference: 'The price the quotes are built around: the mid of the external book, excluding Staple’s own orders.',
  mark: 'An independent exchange price used to sanity-check the reference.',
  'loss trigger':
    'When measured loss reaches this amount, quoting stops and cancellation is requested. Loss can exceed it: it is a trigger, not a cap.',
  volatility: 'How far the price moved within a short window. Large moves pull quotes until things calm down.',
  agent:
    'An API wallet the owner approves on Hyperliquid. It can place and cancel orders for the account but cannot withdraw funds.',
  revoke: 'Removing the agent’s permission on Hyperliquid. Only the account owner can do this, from their own wallet.',
  keeper: 'The service that turns on-chain intents into real exchange orders and reports what happened back on-chain.',
  watcher:
    'A separate service that checks every exchange order and fill against the contract’s intents and raises the alarm on any mismatch.',
  intent: 'An order the contract decided should exist, published on Elysium before anything is sent to the exchange.',
  reconciliation: 'Checking that the account’s real balances and orders are fully explained by recorded intents and fills.',
  'residual inventory': 'Tokens still held after shutdown. Their value keeps moving with the market until the owner acts.',
  notional: 'The value of an order or trade in quote currency (price × size).',
  'time at target': 'Share of sampled seconds where the book’s spread and depth on both sides met the published target.',
};
