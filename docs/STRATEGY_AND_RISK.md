# Strategy & Risk Reference

## Strategy: regime-aware, multi-timeframe confluence

Rule-based and fully logged - no ML black boxes. Every decision records the
reason trace, regime classification, stop distance, planned reward, position
size, and risk amount into the activity feed.

### A. Trend filter (long-only bias)

Entry only when BOTH are true:
- 1h EMA(21) > 1h EMA(50)
- 15m EMA(9) > 15m EMA(21)

The bot never shorts. No trend = no trade (cash is the neutral position).

### B. Entry trigger (one of)

- Breakout: 15m close above the prior 16-candle high, close within 1.0 x
  ATR of that level.
- Mean-reversion bounce: recent lows pierce or touch the prior 16-candle
  support within 0.3 x ATR and a bullish close prints above it.

Confirmed by:
- RSI(14) strictly between 30 and 70 (no chasing extremes),
- entry candle volume at least 1.5x the 20-period average.

### C. Volatility regime filter

ATR(14) percentile of the trailing 200 closed 15m candles must sit between
the 20th and 90th percentile. Dead tape and news-spike chaos are skipped.
Stop distance = max(ATR x 1.5, 1.5% of price).

### D. Order book microstructure (Gemini L1/L2)

Before entering: spread at most 10 bps and at least $5,000 resting within 1%
of mid, else skip. Entries are post-only (maker) limits at the best bid.

### E. Time filter

- No entries in the first 15 minutes after the hourly close.
- No entries 02:00-05:59 UTC unless the volume confirmation already fired.

### F. Frequency & cooldown

- Max 1 setup per 4h window per symbol (rolling buckets).
- Default 5 trades per symbol per day (configurable, hard-capped by env).
- Default 45-minute cooldown between trades on the same symbol.
- If no fresh price tick within 60s (WebSocket or REST), new entries pause
  (stale-price kill switch) until data resumes.

### G. Third coin rule (auto-validated)

The third symbol (SOL by default) is only traded if:
- Gemini 24h volume is healthy,
- spread stays under 0.1%,
- 30-day daily-return correlation to BTC (and ETH) stays below 0.85.

If correlation is too high the third symbol is excluded and the bot trades
BTC/ETH only with 25% tighter risk. Correlations refresh hourly from real
Gemini daily candles and are exposed at GET /api/correlations.

## Hard risk guards (absolute, never bypassed)

1. Account floor: no order unless available USD is at least $10; projected
   balance after fees can never go below $0. No leverage, no margin, no
   shorting, no options or futures.
2. Position sizing (automatic, Kelly-lite): qty = (equity x risk%) /
   (entry - stop), rounded DOWN to the symbol step size, never above the
   configured risk cap (hard max 3%).
3. Volatility-adjusted stop: max(ATR x 1.5, 1.5% of price).
4. Risk:reward slider (0.5x - 3.0x, default 1.5x) moves ONLY the take-profit
   distance. It can never increase position size.
5. Fee & slippage check: maker+taker fees plus 2 bps slippage are subtracted
   from the projected reward; if net RR < 1.2 the trade is aborted.
6. Daily loss breaker: at -3% day P&L (realized + unrealized, fees included)
   new entries halt for the day; at -5% everything flattens and autopilot
   disables until manually re-enabled.
7. Concurrency caps: max 1 position per symbol, 3 total.
8. Buying power: at most 50% of available USD committed at once.
9. Correlation cap: no new third-coin entry when its correlation to held
   symbols exceeds 0.8; the 30-day BTC correlation rule gates it entirely
   above 0.85.
10. Emergency stop: one tap cancels all orders, flattens at market, halts.

## Auto trade management (bot-run exits)

- A stop-limit sell and a take-profit limit go live on Gemini immediately
  after entry. If the stop cannot be placed, the position is exited at once -
  unprotected positions never exist.
- OCO emulation: when one side fills, the sibling order is cancelled.
- Breakeven: after +1R the stop moves to entry plus a fee buffer.
- Trailing: after +1R the stop trails price by 0.5 x ATR (entry ATR),
  only ever upward.
- Partial profit (optional flag): sell 50% at +1R, stop to breakeven.
- Time exit: after 4 hours open, if the 1h trend has flipped, exit at market.
- Every move is logged and pushed to the apps.
