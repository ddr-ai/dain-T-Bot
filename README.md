# dain-T-Bot - Gemini Autopilot Crypto Trading Bot

Fully autonomous, set-and-forget SPOT trading bot for the Gemini exchange with
an unsigned-sideloading iOS app and an installable PWA. You set risk
preferences once; the bot scans, enters, sizes, stops, trails, and exits on
its own - and tells you what it did.

- Spot only. Long only. No leverage, no margin, no shorting, no futures.
- Account floor: available cash can never go below $0, never trades with
  less than $10, machines-honest daily circuit breakers (-3% halt / -5% flatten).
- Withdrawals are never possible from the bot's key (see docs/GEMINI_SETUP.md).

DISCLAIMER: live trading involves risk of loss. This is not financial advice.
There is no guarantee of profit; you can lose your entire balance. Validate
in paper mode and read docs/VALIDATION.md before going live.

## Repository layout

    backend/                 Node 22 + TypeScript trading engine (ZERO npm dependencies)
      src/gemini/            REST signing (HMAC-SHA384), nonce mutex, WS client (RFC6455 hand-rolled)
      src/strategy/         indicators, regime filters, rule-based signals
      src/risk/guards.ts    the hard risk engine (sizing, RR abort, breakers)
      src/engine/           autopilot loop, paper + live brokers, trade management
      src/api/              REST + WebSocket server (node:http, hand-rolled RFC6455)
      src/cli/backtest.ts   walk-forward + Monte Carlo backtester
      test/                 unit tests (node:test, no framework)
    ios/                    SwiftUI app (iOS 16+) + XcodeGen project
    pwa/                    React + Vite PWA (manifest, service worker, offline)
    .github/workflows/      CI, unsigned .ipa build (esign-ready)
    docs/                   setup, sideload, validation, strategy, deployment

## Quick start - HOSTED ENGINE (recommended, zero setup)

The engine is deployed as Netlify Functions + Blobs (state survives in a
private blob store, a scheduled function ticks it every minute even with no
app open). The PWA and the API live on one site:

    https://dain-t-bot.netlify.app

1. Open the URL, go to Settings, paste the API_AUTH_TOKEN (shared privately),
   and save your Gemini key (Balances + Orders only). Both are AES-256-GCM
   encrypted with CREDS_MASTER_KEY before they touch storage.
2. On the dashboard pick a run window (1h .. 7d) and press START RUN.
   Live mode is the default; toggle Settings -> Paper to simulate instead.
3. When the window ends (or you press STOP RUN), new entries stop but open
   positions keep being managed until stops/targets close them.
   EMERGENCY STOP ALL flattens immediately at market.

The iOS app connects to the same URL: paste it on the Connect screen (it is
pre-filled) plus the same API_AUTH_TOKEN. The hosted engine and the
standalone backend speak the identical REST contract, so either can be
swapped in at any time. netlify/smoke.ts runs an offline-ish local test of
the serverless tick with a stub for @netlify/blobs.

## Quick start - backend (paper mode, no key needed)

Requires Node 22.6 or newer (TypeScript runs natively; no npm install).

    cp .env.example .env
    cd backend
    npm test          # 33 unit tests
    npm start         # starts on :3000, PAPER mode, autopilot OFF

Then either flip autopilot in an app, or:

    curl -X POST localhost:3000/api/autopilot -d '{"enabled":true}' -H 'Content-Type: application/json'

The engine opens WebSocket feeds for btcusd/ethusd/solusd, scans every 60s,
manages open positions every 15s, and logs every decision with reasons.
Paper fills are simulated against real public prices with maker/taker fees.

## Quick start - PWA

    cd pwa
    npm install
    npm run dev       # vite at :5173, proxies /api and /ws to :3000

Production build: npm run build, then host pwa/dist statically (see
docs/DEPLOYMENT.md). Installable on iOS Safari (Add to Home Screen) and
Android Chrome (install prompt); service worker caches the shell and last
API responses for offline viewing.

## Quick start - iOS app (unsigned, sideload with esign)

1. Push to GitHub - the workflow Build unsigned iOS IPA produces
   AutopilotTrader-unsigned.ipa as an artifact on every push (or run it
   manually from the Actions tab).
2. Follow docs/SIDELOAD_IOS.md to sign and install via esign.
3. In the app: connect to your backend URL, done.

## What the bot does automatically

Setup detection (1-minute momentum / dip-buy: 5m+1m trend alignment, 8-bar
momentum breaks or EMA21 dip-buys, RSI + volume confirmation),
volatility regime filtering, order-book liquidity checks, time filters,
position sizing, entry (post-only maker), stop-loss + take-profit placement
on-exchange, OCO emulation, breakeven moves, ATR trailing, optional partial
profits, time-based exits, daily circuit breakers, correlation gating of the
third coin, stale-feed kill switch, emergency flatten. Full detail:
docs/STRATEGY_AND_RISK.md.

## What you control

Autopilot ON/OFF, the risk:reward slider (moves take-profit only), risk %,
daily loss limits, paper/live switch, notification preferences, and the big
red Emergency Stop. You are notified of every action via the activity feed,
push events on the WS, and (on iOS) local notifications. No per-trade
approvals - that is the point, and also the risk.

## Configuration

Copy .env.example to .env. Key variables:

    GEMINI_API_KEY / GEMINI_API_SECRET    Balances + Orders only, NO withdrawals
    GEMINI_BASE_URL                       sandbox first, api.gemini.com for live
    PAPER_TRADING=true                    default ON; live requires explicit switch
    RISK_PER_TRADE_PCT=1.5                capped at MAX_RISK_PER_TRADE_PCT=3
    DAILY_LOSS_WARNING_PCT=3.0            halt new entries
    DAILY_LOSS_LIMIT_PCT=5.0              flatten + disable until manual reset
    MAX_BUYING_POWER_PCT=50.0             dry powder rule
    ENCRYPTION_KEY                        32-byte base64; encrypts credentials at rest
    API_AUTH_TOKEN                        bearer token for the REST/WS API

Full annotated list with defaults lives in .env.example.

## Validation before live (mandatory)

1. npm test - unit tests for the risk engine, indicators, signals, brokers.
2. Paper soak test 1-2 weeks (see docs/VALIDATION.md).
3. Walk-forward backtest + Monte Carlo:

       cd backend && npm run backtest -- --symbol btcusd

4. Optional live sandbox with a Gemini sandbox key.
5. Go-live gate: docs/VALIDATION.md checklist, then flip PAPER_TRADING=false
   (or the in-app switch) with a live key that has withdrawals DISABLED.

## Design notes

- Zero runtime dependencies: the HTTP server, the WebSocket client AND server
  (RFC6455), HMAC signing, and AES-256-GCM vault are implemented on the Node
  standard library. Fewer supply-chain surprises, instant setup.
- TypeScript runs natively on Node 22 (node --experimental-transform-types).
- Nonces are serialized behind a mutex; concurrent private requests can never
  reuse a nonce (Gemini rejects that hard).
- The Gemini feed lacks native OCO for spot stop-limits, so the trade manager
  polls order states and cancels the sibling leg the moment one side fills.
- Public market data always comes from api.gemini.com (even in sandbox/paper),
  so decisions use real prices; only order routing differs by mode.

## Legal

MIT licensed (see LICENSE). Not financial advice. Trading involves risk of
loss. You are responsible for complying with the laws and exchange rules
that apply to you, and for the safety of your own API keys.
