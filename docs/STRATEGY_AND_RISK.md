# Strategy & Risk Reference

## Strategy: 5-minute session opening-range (ORB), long-only

Rule-based and fully logged - no ML black boxes. Every decision records the
reason trace, stop distance, planned reward, position size, and risk amount
into the activity feed.

The method implements the "first 5-minute candle" variant of the Opening
Range Breakout from Carlo Zarattini & Andrew Aziz, "Can Day Trading Really
Be Profitable?" (SSRN 4416622, 2023). Their QQQ backtest (2016-2023) netted
+676% vs +169% buy-and-hold, with a 24% win rate and +0.13R average per
trade. Honest context: a 2026 independent replication with realistic spread
and slippage on index CFDs found the edge roughly equals the cost load - so
treat this as a selective, risk-controlled method, not free money.

### A. Session (crypto adaptation)

The session is the UTC calendar day: it opens at 00:00 UTC, crypto's daily
boundary and perp-funding settlement (the analog of the 9:30 equity open).
Weekend sessions are skipped - weekend books are thin and fills are poor.
The engine is long-only; the paper also trades the short side, which is
deliberately skipped here.

### B. Entry trigger (one per session per symbol)

Watch the FIRST 5-minute candle of the session (00:00-00:05 UTC) - that
candle is the opening range:

- Bullish close (close > open): go long at the next candle's open.
- Bearish or flat close: no trade today for that symbol.

The entry window is the second 5-minute candle of the session
(00:05-00:10 UTC). If a market-quality or risk gate blocks the fill, the
engine retries on the next tick inside that window; once the window closes,
the session is over for that symbol.

### C. Stop, target, and exit

- Stop loss at the LOW of the first candle, floored at 0.8% of price. The
  floor exists because fees cost ~0.64% round trip at Gemini retail rates;
  sub-fee stops lose more than 1R in practice.
- Take-profit at RR x the stop distance. Default RR is 10x - the paper's
  10R target. Win rate is low by design; a few big winners pay for many
  small losses.
- No trailing stop: winners run to the target or the session close. The
  breakeven move at +1R (stop to entry + fee buffer) still protects.
- Time exit: everything flat ~23h after entry (unconditional) - no position
  carries into the next session.

### D. Order book microstructure (Gemini L1/L2)

Before entering: spread at most 10 bps and at least $5,000 resting within 1%
of mid, else skip (and retry on the next tick inside the window). Live
entries are IOC taker buys crossing the ask; paper entries fill at the
ticker price.

### E. Time filter

- No entries 02:00-05:59 UTC unless the entry candle's volume is at least
  1.5x its 20-bar average. (The 00:05-00:10 entry window is unaffected.)

### F. Frequency & cooldown

- One entry attempt per session per symbol; the entry window itself caps
  re-tries.
- Max 1 setup per 4h window per symbol (rolling buckets), 2 trades per
  symbol per day, 30-minute cooldown (configurable, hard-capped by env).
- If no fresh price tick within 60-90s (poll or REST), new entries pause
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
3. Opening-range stop: the first candle's low, floored at 0.8% of price
   (fee floor - a stop tighter than the round-trip cost loses more than 1R).
4. Risk:reward slider (2.2x - 10.0x, default 10.0x, the paper's 10R target)
   moves ONLY the take-profit distance. It can never increase position size.
5. Fee & slippage check: maker+taker fees plus 2 bps slippage are subtracted
   from the projected reward; if net RR < 1.2 the trade is aborted. At the
   default 10R this gate passes easily; it protects if you slide the RR down.
6. Daily loss breaker: at -3% day P&L (realized + unrealized, fees included)
   new entries halt for the day; at -5% everything flattens and autopilot
   disables until manually re-enabled.
7. Concurrency caps: max 1 position per symbol, 3 total.
8. Buying power: at most 30% of available USD committed at once.
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
- No trailing stop: the ORB edge is letting winners run to the 10R target
  or the session close. Only the breakeven move protects past +1R.
- Partial profit (optional flag): sell 50% at +1R, stop to breakeven.
- Time exit: after 23 hours open, exit unconditionally at market (session
  close) - nothing carries into the next session.
- Every move is logged and pushed to the apps.
