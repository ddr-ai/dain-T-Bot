// Rule-based entry detection - 1-MINUTE method (overwrites the old 15m/1h
// breakout method). The first candle array is the SIGNAL frame (1 minute),
// the second is the TREND frame (5 minutes); the frame length is inferred
// from the candle timestamps, so the same code runs on any pair of frames.
//
// Method:
//   A) Trend filter: 5m EMA21 > EMA50 (macro bias) AND 1m EMA9 > EMA21
//      (micro alignment). Both must be long.
//   B) Volatility regime: ATR(14) on 1m candles must sit in its 20-90%
//      percentile band - no dead chop, no panic spikes.
//   C) Triggers on the last CLOSED 1m candle, confirmed by RSI + volume:
//        - momentum: close breaks the prior 8-bar high, not overextended
//          (within 1.5 ATR), volume >= volumeMult x the 20-bar average,
//          RSI in the 45-78 momentum zone.
//        - dip-buy: pullback that touches the 1m EMA21 from above, closes
//          back above it, RSI 35-62, volume at least 0.7x average.
//   D) Stop distance = max(ATR x atrMult, minStopPct% floor). At Gemini
//      retail fees (~0.6% round trip) the floor keeps stops wide enough
//      that the net-RR-after-fees gate can actually pass on 1m signals.
//
// Every decision returns a full reason trace so the activity feed can say
// exactly why the bot did (or did not) trade.

import type { Candle } from '../gemini/types.ts'
import { atr, ema, highestOf, lowestOf, mean, percentileRank, rsi } from './indicators.ts'

export interface SignalCfg {
  atrMult: number
  minStopPct: number
  volumeMult: number
}

export interface SetupDecision {
  enter: boolean
  kind: 'momentum' | 'dip-buy' | null
  reasons: string[]
  atr: number
  stopDist: number
  rsi: number
  volumeRatio: number
  trendOK: boolean
  atrRank: number
  trendState: number // 5m ema gap %, used for time-exit trend flip checks
}

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
  return 60_000
}

// Trend bias of the TREND frame: EMA21 vs EMA50 on closes.
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

export function evaluateSetup(
  candles1m: Candle[],
  candles5m: Candle[],
  nowMs: number,
  cfg: SignalCfg
): SetupDecision {
  const reasons: string[] = []
  const c1m = closedOnly(candles1m, frameOf(candles1m), nowMs)
  const c5m = closedOnly(candles5m, frameOf(candles5m), nowMs)

  const base: SetupDecision = {
    enter: false, kind: null, reasons, atr: NaN, stopDist: NaN,
    rsi: NaN, volumeRatio: NaN, trendOK: false, atrRank: NaN, trendState: NaN
  } as SetupDecision

  if (c1m.length < 60) {
    reasons.push('insufficient 1m history')
    return base
  }
  if (c5m.length < 51) {
    reasons.push('insufficient 5m history')
    return base
  }

  // A) Multi-timeframe trend filter (5m macro + 1m micro alignment)
  const t5 = trendBiasEma(c5m)
  base.trendState = Number.isFinite(t5.gapPct) ? t5.gapPct : 0
  const closes = c1m.map((x) => x.c)
  const e9 = ema(closes, 9)
  const e21 = ema(closes, 21)
  const microLong = Number.isFinite(e9[e9.length - 1]) && Number.isFinite(e21[e21.length - 1]) && e9[e9.length - 1] > e21[e21.length - 1]
  if (!(t5.long && microLong)) {
    reasons.push('trend filter: not long-biased (5m EMA21 vs EMA50: ' + (Number.isFinite(t5.gapPct) ? t5.gapPct.toFixed(2) : '?') + '%)')
    return base
  }
  base.trendOK = true
  reasons.push('trend filter: long-biased on 5m + 1m EMA alignment')

  const i = c1m.length - 1 // last CLOSED candle
  const cand = c1m[i]
  const prev = c1m[i - 1]
  const lastEma21 = e21[e21.length - 1]

  // Volume confirmation vs the trailing 20-bar average
  const volWindow: number[] = []
  for (let k = Math.max(1, i - 20); k < i; k++) volWindow.push(c1m[k].v)
  const avgVol = mean(volWindow)
  base.volumeRatio = avgVol > 0 ? cand.v / avgVol : 1

  // RSI momentum read
  const rsiSeries = rsi(closes, 14)
  base.rsi = rsiSeries[rsiSeries.length - 1]

  // B) Volatility regime: ATR percentile of the trailing 200 closed candles
  const atrSeries = atr(c1m, 14)
  base.atr = atrSeries[atrSeries.length - 1]
  const trailing: number[] = []
  for (let k = Math.max(14, i - 200); k <= i; k++) {
    const v = atrSeries[k]
    if (Number.isFinite(v)) trailing.push(v)
  }
  base.atrRank = percentileRank(trailing, base.atr)
  if (!Number.isFinite(base.atr) || !Number.isFinite(base.atrRank) || base.atrRank < 0.2 || base.atrRank > 0.9) {
    reasons.push('ATR regime: rank ' + (Number.isFinite(base.atrRank) ? (base.atrRank * 100).toFixed(0) + '%' : '?') + ' outside 20-90% band')
    return base
  }
  reasons.push('ATR regime: rank ' + (base.atrRank * 100).toFixed(0) + '% (mid band)')

  // Stop distance from ATR, floored at minStopPct
  base.stopDist = Math.max(base.atr * cfg.atrMult, cand.c * (cfg.minStopPct / 100))
  if (!(base.stopDist > 0 && base.stopDist < cand.c * 0.25)) {
    reasons.push('stop distance out of sane bounds')
    return base
  }

  // C) Entry triggers on the last closed 1m candle
  const lookback = 8
  const priorHigh = highestOf(c1m.map((x) => x.h), lookback, i)
  const priorLow = lowestOf(c1m.map((x) => x.l), lookback, i)
  const bullish = cand.c > cand.o

  const momentum =
    Number.isFinite(priorHigh) &&
    bullish &&
    cand.c > priorHigh &&
    cand.c - priorHigh <= base.atr * 1.5 &&
    base.volumeRatio >= cfg.volumeMult &&
    Number.isFinite(base.rsi) && base.rsi >= 45 && base.rsi <= 78

  const emaTouch = Number.isFinite(lastEma21) && Number.isFinite(base.atr) &&
    Math.min(cand.l, prev.l) <= lastEma21 + base.atr * 0.75
  const dipBuy =
    emaTouch &&
    bullish &&
    cand.c > lastEma21 &&
    base.volumeRatio >= 0.7 &&
    Number.isFinite(base.rsi) && base.rsi >= 35 && base.rsi <= 62

  if (momentum) {
    base.kind = 'momentum'
    reasons.push('trigger: 1m momentum break above ' + priorHigh.toFixed(2) + ' to ' + cand.c.toFixed(2) + ' (vol ' + base.volumeRatio.toFixed(1) + 'x, RSI ' + base.rsi.toFixed(1) + ')')
    base.enter = true
  } else if (dipBuy) {
    base.kind = 'dip-buy'
    reasons.push('trigger: dip-buy at 1m EMA21 ' + lastEma21.toFixed(2) + ', closed ' + cand.c.toFixed(2) + ' (RSI ' + base.rsi.toFixed(1) + ')')
    base.enter = true
  } else {
    reasons.push('no setup: last 1m close ' + cand.c.toFixed(2) + ' inside ' + (Number.isFinite(priorLow) ? priorLow.toFixed(2) : '?') + ' - ' + (Number.isFinite(priorHigh) ? priorHigh.toFixed(2) : '?') + ' range (vol ' + base.volumeRatio.toFixed(2) + 'x, RSI ' + (Number.isFinite(base.rsi) ? base.rsi.toFixed(1) : '?') + ')')
  }
  return base
}
