// Rule-based entry detection - 5-MINUTE SESSION OPENING-RANGE method,
// implementing the "first 5-minute candle" variant of the Opening Range
// Breakout (ORB) strategy from:
//   Carlo Zarattini & Andrew Aziz, "Can Day Trading Really Be Profitable?"
//   (SSRN 4416622, 2023) - QQQ backtest 2016-2023: +676% net vs +169%
//   buy-and-hold, 24% win rate, +0.13R average per trade.
//
// The paper's rule, adapted long-only for 24/7 crypto on Gemini:
//   A) Session = UTC calendar day (00:00 UTC open - crypto's daily boundary
//      and perp-funding settlement). Weekends are skipped (thin books).
//   B) Trigger: the FIRST 5-minute candle of the session (00:00-00:05 UTC).
//      Bullish close -> long at the next candle's open. Bearish or flat ->
//      no trade (the paper also shorts; this engine is long-only by design).
//   C) Stop loss at the LOW of the first candle, floored at MIN_STOP_PCT
//      (fees cost ~0.64% round trip at retail rates, so sub-fee stops lose
//      more than 1R in practice). Take-profit at RR x stop (paper: 10R).
//   D) Time exit: everything flat before the next session (paper exits at
//      the session close). The trade managers close positions unconditionally
//      TIME_EXIT_HOURS after entry - no trailing stop, winners run.
//
// One trade attempt per session per symbol; the entry window is the second
// 5-minute candle of the session (00:05-00:10 UTC) so the decision only uses
// fully closed data. Every decision returns a full reason trace.

import type { Candle } from '../gemini/types.ts'
import { atr, ema, mean, percentileRank, rsi } from './indicators.ts'

export interface SignalCfg {
  minStopPct: number
}

export interface SetupDecision {
  enter: boolean
  kind: 'orb' | null
  reasons: string[]
  atr: number
  stopDist: number
  rsi: number
  volumeRatio: number
  trendOK: boolean
  atrRank: number
  trendState: number // 30m ema gap %, context only (the paper has no trend filter)
}

const DAY_MS = 86_400_000
const FIVE_MIN_MS = 300_000

// Drop the still-forming candle so decisions only use closed data.
export function closedOnly(candles: Candle[], frameMs: number, nowMs: number): Candle[] {
  if (candles.length === 0) return candles
  const last = candles[candles.length - 1]
  if (nowMs - last.t < frameMs) return candles.slice(0, candles.length - 1)
  return candles
}

// Frame length from the data itself (uniform exchange candles).
function frameOf(candles: Candle[]): number {
  const n = candles.length
  for (let k = n - 1; k > 0 && k > n - 4; k--) {
    const d = candles[k].t - candles[k - 1].t
    if (d > 0) return d
  }
  return FIVE_MIN_MS
}

// Trend bias of the TREND frame: EMA21 vs EMA50 on closes. Context only for
// the ORB method (the paper has no trend filter) - kept for logs and tools.
export function trendBiasEma(candlesClosed: Candle[]): { long: boolean, gapPct: number } {
  if (candlesClosed.length < 51) return { long: false, gapPct: NaN }
  const closes = candlesClosed.map((c) => c.c)
  const e21 = ema(closes, 21)
  const e50 = ema(closes, 50)
  const last21 = e21[e21.length - 1]
  const last50 = e50[e50.length - 1]
  const long = Number.isFinite(last21) && Number.isFinite(last50) && last21 > last50
  const gapPct = Number.isFinite(last21) && Number.isFinite(last50) && last50 !== 0 ? ((last21 - last50) / last50) * 100 : NaN
  return { long, gapPct }
}

// Back-compat alias: the old name is referenced by tools/tests.
export const trendBias1h = trendBiasEma

function utcWeekday(sessionStartMs: number): number {
  return new Date(sessionStartMs).getUTCDay() // 0 = Sunday, 6 = Saturday
}

export function evaluateSetup(
  candles5m: Candle[],
  candles30m: Candle[],
  nowMs: number,
  cfg: SignalCfg
): SetupDecision {
  const reasons: string[] = []
  const c5 = closedOnly(candles5m, frameOf(candles5m), nowMs)
  const c30 = closedOnly(candles30m, frameOf(candles30m), nowMs)

  const base: SetupDecision = {
    enter: false, kind: null, reasons, atr: NaN, stopDist: NaN,
    rsi: NaN, volumeRatio: NaN, trendOK: false, atrRank: NaN, trendState: NaN
  } as SetupDecision

  // A) Session = UTC calendar day; the opening range is its first candle.
  const sessionStart = Math.floor(nowMs / DAY_MS) * DAY_MS
  const sessionMin = (nowMs - sessionStart) / 60_000

  // 30m trend context (logged, never gates the entry)
  const t30 = trendBiasEma(c30)
  base.trendState = Number.isFinite(t30.gapPct) ? t30.gapPct : 0

  if (utcWeekday(sessionStart) === 0 || utcWeekday(sessionStart) === 6) {
    reasons.push('weekend session skipped (thin crypto liquidity)')
    return base
  }
  if (sessionMin < 5) {
    reasons.push('opening range (first 5m candle) still forming')
    return base
  }
  if (sessionMin >= 10) {
    reasons.push('outside session entry window (first 5m candle only)')
    return base
  }

  // B) The session's first 5m candle is the opening range.
  let first: Candle | undefined
  for (const c of c5) {
    if (c.t >= sessionStart && c.t < sessionStart + FIVE_MIN_MS) {
      first = c
      break
    }
    if (c.t >= sessionStart + FIVE_MIN_MS) break // sorted data: past the range
  }
  if (!first) {
    reasons.push('no first candle for this session (data gap)')
    return base
  }

  // Context metrics for the log trace (the paper uses none of them as filters)
  const i = c5.length - 1
  const cand = c5[i]
  const volWindow: number[] = []
  for (let k = Math.max(0, i - 20); k < i; k++) volWindow.push(c5[k].v)
  const avgVol = mean(volWindow)
  base.volumeRatio = avgVol > 0 ? cand.v / avgVol : 1
  const closes = c5.map((x) => x.c)
  const rsiSeries = rsi(closes, 14)
  base.rsi = rsiSeries[rsiSeries.length - 1]
  const atrSeries = atr(c5, 14)
  base.atr = atrSeries[atrSeries.length - 1]
  const trailing: number[] = []
  for (let k = Math.max(14, i - 200); k <= i; k++) {
    const v = atrSeries[k]
    if (Number.isFinite(v)) trailing.push(v)
  }
  base.atrRank = trailing.length > 0 ? percentileRank(trailing, base.atr) : NaN

  // Bullish opening range -> long; bearish/flat -> no long trade.
  const bullish = first.c > first.o
  if (!bullish) {
    reasons.push('first 5m candle ' + (first.c === first.o ? 'flat' : 'bearish') + ' (' + first.o.toFixed(2) + ' -> ' + first.c.toFixed(2) + ') - no long trade (paper short side skipped, engine is long-only)')
    return base
  }

  // C) Stop at the opening-range low, floored at minStopPct (fee floor).
  //    Entry reference = the first candle's close (we fill at the next
  //    candle's open, which opens at that price).
  const entryRef = first.c
  base.stopDist = Math.max(entryRef - first.l, entryRef * (cfg.minStopPct / 100))
  if (!(base.stopDist > 0 && base.stopDist < entryRef * 0.25)) {
    reasons.push('stop distance out of sane bounds')
    return base
  }

  base.kind = 'orb'
  base.trendOK = true
  base.enter = true
  reasons.push('ORB: first 5m candle bullish ' + first.o.toFixed(2) + ' -> ' + first.c.toFixed(2) + ', range low ' + first.l.toFixed(2) + ', stop dist ' + base.stopDist.toFixed(2) + ' (' + ((base.stopDist / entryRef) * 100).toFixed(2) + '% of price)')
  return base
}
