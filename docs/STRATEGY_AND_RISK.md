# Strategy & Risk Reference

## Strategy: 1-minute momentum / dip-buy (regime-aware)

Rule-based and fully logged - no ML black boxes. Every decision records the
reason trace, regime classification, stop distance, planned reward, position
size, and risk amount into the activity feed.

The signal frame is 1 minute, the trend frame is 5 minutes. Decisions are
made on closed candles only. Because retail exchange fees are roughly 0.6% per
round trip, the method is deliberately selective: a "1 minute method" scans
every minute but only fires when the full confluence stack lines up.

### A. Trend filter (long-only bias)

Entry only when BOTH are true:
- 5m EMA(21) > 5m EMA(50) (macro bias)
- 1m EMA(9) > 1m EMA(21) (micro alignment)

The bot never shorts. No trend = no trade (cash is the neutral position).

### B. Entry trigger (one of)

- Momentum: 1m close breaks the prior 8-bar high, not overextended
  (within 1.5 x ATR of that level), RSI(14) in the 45-78 momentum zone.
- Dip-buy: pullback touches the 1m EMA(21) from above (within 0.75 x ATR),
  bullish close back above it, RSI 35-62.

Confirmed by volume:
- momentum requires volume >= 1.5x the 20-bar average,
- dip-buy requires volume >= 0.7x the 20-bar average.

### C. Volatility regime filter

ATR(14) percentile of the trailing 200 closed 1m candles must sit between
the 20th and 90th percentile. Dead tape and news-spike chaos are skipped.
Stop distance = max(ATR x 2.0, 0.8% of price) - the floor exists because
fees consume ~0.6% round trip, so sub-0.8% stops lose even when price
moves the right way.

### D. Order book microstructure (Gemini L1/L2)

Before entering: spread at most 10 bps and at least $5,000 resting within 1%
of mid, else skip. Live entries are IOC taker buys crossing the ask; paper
entries fill at the ticker price.

### E. Time filter

- No entries in the first 15 minutes after the hourly close.
- No entries 02:00-05:59 UTC unless the volume confirmation already fired.

### F. Frequency & cooldown

- Max 4 setups per 4h window per symbol (rolling buckets).
- Default 8 trades per symbol per day (configurable, hard-capped by env).
- Default 5-minute cooldown between trades on the same symbol.
- If no fresh price tick within 60s (poll or REST), new entries pause
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
3. Volatility-adjusted stop: max(ATR x 2.0, 0.8% of price).
4. Risk:reward slider (2.2x - 4.0x, default 2.5x) moves ONLY the take-profit
   distance. It can never increase position size.
5. Fee & slippage check: maker+taker fees plus 2 bps slippage are subtracted
   from the projected reward; if net RR < 1.2 the trade is aborted. This is
   what makes the engine selective on 1m signals - fee drag is real.
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
- Trailing: after +1R the stop trails price by max(0.5 x ATR, 25% of the
  initial stop distance), only ever upward. The floor exists because 1m ATR
  alone would trail impossibly tight and shake out winners on noise.
- Partial profit (optional flag): sell 50% at +1R, stop to breakeven.
- Time exit: after 1.5 hours open, if the 5m trend has flipped, exit at market.
- Every move is logged and pushed to the apps.
