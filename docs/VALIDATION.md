# Validation & Go-Live Guide (mandatory before LIVE)

Do NOT enable live autopilot until every step below passes. This is the gate
between "interesting prototype" and "robot spending my money".

## Step 0 - Freeze the configuration

    PAPER_TRADING=true
    RISK_PER_TRADE_PCT=1.5        # 1-2 recommended, never above 3
    DAILY_LOSS_WARNING_PCT=3.0
    DAILY_LOSS_LIMIT_PCT=5.0
    MAX_BUYING_POWER_PCT=50

## Step 1 - Paper trading soak test (minimum: 1-2 weeks)

- Run with PAPER_TRADING=true and autopilot ON continuously.
- Goal: zero guard violations in logs, no account-below-$0 events, orders and
  exits behave as documented, WebSocket reconnects survive network blips.
- Judge the activity feed: every entry/exit must carry a reason, stop,
  target, size, and risk amount. If that audit trail feels insufficient, fix
  it before going live.
- Track results: with ~1316 available 15m candles of public history per run,
  aim for at least 20-30 paper trades across all symbols before judging.

## Step 2 - Walk-forward backtest (CLI included)

    cd backend
    npm run backtest -- --symbol btcusd

The CLI:
- pulls public 15m + 1hr candles from Gemini v2,
- trains on the first 70% of the window over a small parameter grid
  (volume multiple x ATR multiplier),
- validates out-of-sample on the last 30%,
- applies maker/taker fees + 2 bps slippage on both legs of every trade,
- writes backend/data/backtest-report.json.

Acceptance: out-of-sample profit factor above 1.0, max drawdown under your
daily loss limit, at least 10 trades in the validation window. For deeper
history, dump raw v2 candle rows to a JSON file and pass
--candles-file dump.json (see src/cli/backtest.ts).

## Step 3 - Monte Carlo resampling

Reported automatically at the end of the backtest: the trade sequence is
shuffled 1000 times (deterministic LCG, reproducible) and the worst and 95th
percentile drawdowns are printed. Acceptance:
- ruin sequences (equity wiped to -100%): 0.00%
- 95th percentile drawdown below the daily loss limit. If not, halve
  RISK_PER_TRADE_PCT and re-run.

## Step 4 - Live sandbox (optional but recommended)

Set a sandbox API key with GEMINI_BASE_URL=https://api.sandbox.gemini.com and
PAPER_TRADING=false. This exercises the real order pipeline (stop-limit
placement, maker or cancel, cancel API, nonce behavior) on play money.

## Step 5 - Go-live checklist

- [ ] Paper soak test: 2+ weeks, no guard violations.
- [ ] Walk-forward out-of-sample PF > 1.0.
- [ ] Monte Carlo: 0% ruin, 95th percentile DD under daily limit.
- [ ] Gemini live key: Balances + Orders only, WITHDRAWALS DISABLED.
- [ ] API_AUTH_TOKEN set on the backend (it is internet-reachable).
- [ ] ENCRYPTION_KEY set; credentials stored via the app, not .env.
- [ ] START SMALL: keep the account near the minimum for the first week.
- [ ] You explicitly switch PAPER_TRADING=false (or paper toggle in-app)
- [ ] Emergency stop button tested and works in live mode.

## Risk disclaimer

Live trading involves risk of loss. Automated trading can lose money faster
than manual trading. Nothing in this repo is financial advice. You can lose
your entire account balance. Only run this with money you can afford to lose.
