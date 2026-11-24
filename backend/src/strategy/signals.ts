// Rule-based entry detection: multi-timeframe trend filter, then either a
// momentum breakout or a mean-reversion bounce, confirmed by RSI + volume.
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
  kind: 'breakout' | 'support-bounce' | null
  reasons: string[]
  atr: number
  stopDist: number
  rsi: number
  volumeRatio: number
  trendOK: boolean
  atrRank: number
  trendState: number // ema gaps, used for time-exit trend flip checks
}

const FRAME_15M_MS = 15 * 60 * 1000
const FRAME_1H_MS = 60 * 60 * 1000

// Drop the still-forming candle so decisions only use closed data.
export function closedOnly(candles: Candle[], frameMs: number, nowMs: number): Candle[] {
  if (candles.length === 0) return candles
  const last = candles[candles.length - 1]
  if (nowMs - last.t < frameMs) return candles.slice(0, candles.length - 1)
  return candles
}

export function trendBias1h(candles1hClosed: Candle[]): { long: boolean, gapPct: number } {
  if (candles1hClosed.length < 51) return { long: false, gapPct: NaN }
  const closes = candles1hClosed.map((c) => c.c)
  const e21 = ema(closes, 21)
  const e50 = ema(closes, 50)
  const last21 = e21[e21.length - 1]
  const last50 = e50[e50.length - 1]
  const long = Number.isFinite(last21) && Number.isFinite(last50) && last21 > last50
  const gapPct = Number.isFinite(last21) && Number.isFinite(last50) && last50 !== 0 ? ((last21 - last50) / last50) * 100 : NaN
  return { long, gapPct }
}

export function trendBias15m(candles15mClosed: Candle[]): boolean {
  if (candles15mClosed.length < 22) return false
  const closes = candles15mClosed.map((c) => c.c)
  const e9 = ema(closes, 9)
  const e21 = ema(closes, 21)
  const a = e9[e9.length - 1]
  const b = e21[e21.length - 1]
  return Number.isFinite(a) && Number.isFinite(b) && a > b
}

export function evaluateSetup(
  candles15m: Candle[],
  candles1h: Candle[],
  nowMs: number,
  cfg: SignalCfg
): SetupDecision {
  const reasons: string[] = []
  const c15 = closedOnly(candles15m, FRAME_15M_MS, nowMs)
  const c1h = closedOnly(candles1h, FRAME_1H_MS, nowMs)

  const base: SetupDecision = {
    enter: false, kind: null, reasons, atr: NaN, stopDist: NaN,
    rsi: NaN, volumeRatio: NaN, trendOK: false, atrRank: NaN, trendState: NaN
  } as SetupDecision

  if (c15.length < 60) {
    reasons.push('insufficient 15m history')
    return base
  }
  if (c1h.length < 51) {
    reasons.push('insufficient 1h history')
    return base
  }

  // A) Multi-timeframe trend filter
  const t1h = trendBias1h(c1h)
  const t15 = trendBias15m(c15)
  base.trendState = Number.isFinite(t1h.gapPct) ? t1h.gapPct : 0
  if (!(t1h.long && t15)) {
    reasons.push('trend filter: not long-biased (1h EMA21 vs EMA50: ' + (Number.isFinite(t1h.gapPct) ? t1h.gapPct.toFixed(2) : '?') + '%)')
    return base
  }
  base.trendOK = true
  reasons.push('trend filter: long-biased on 1h + 15m')

  const i = c15.length - 1 // last CLOSED candle
  const cand = c15[i]
  const prev = c15[i - 1]

  // Volume confirmation
  const volWindow: number[] = []
  for (let k = Math.max(1, i - 20); k < i; k++) volWindow.push(c15[k].v)
  const avgVol = mean(volWindow)
  base.volumeRatio = avgVol > 0 ? cand.v / avgVol : 1
  if (!(base.volumeRatio >= cfg.volumeMult)) {
    reasons.push('volume ' + base.volumeRatio.toFixed(2) + 'x < ' + cfg.volumeMult + 'x of 20-period average')
    return base
  }
  reasons.push('volume ' + base.volumeRatio.toFixed(2) + 'x confirms')

  // RSI extremes
  const closes = c15.map((x) => x.c)
  const rsiSeries = rsi(closes, 14)
  base.rsi = rsiSeries[rsiSeries.length - 1]
  if (!Number.isFinite(base.rsi) || base.rsi <= 30 || base.rsi >= 70) {
    reasons.push('RSI ' + (Number.isFinite(base.rsi) ? base.rsi.toFixed(1) : '?') + ' in extreme zone')
    return base
  }
  reasons.push('RSI ' + base.rsi.toFixed(1) + ' neutral')

  // C) Volatility regime: ATR percentile of the trailing 200 closed candles
  const atrSeries = atr(c15, 14)
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

  // B) Entry trigger: breakout above resistance or bounce off support
  const lookback = 16
  const priorHigh = highestOf(c15.map((x) => x.h), lookback, i)
  const priorLow = lowestOf(c15.map((x) => x.l), lookback, i)
  const bullish = cand.c > cand.o

  const breakout = Number.isFinite(priorHigh) && cand.c > priorHigh && (cand.c - priorHigh) <= base.atr * 1.0
  const nearSupport = Number.isFinite(priorLow) && Math.min(cand.l, prev.l) <= priorLow + base.atr * 0.3
  const bounce = nearSupport && bullish && cand.c > priorLow

  if (breakout && bounce) {
    // both triggers fired: the close is above resistance, so breakout wins
    base.kind = 'breakout'
    reasons.push('trigger: breakout (with support overlap) at ' + cand.c)
    base.enter = true
  } else if (breakout) {
    base.kind = 'breakout'
    reasons.push('trigger: breakout above ' + priorHigh.toFixed(2) + ' to ' + cand.c.toFixed(2))
    base.enter = true
  } else if (bounce) {
    base.kind = 'support-bounce'
    reasons.push('trigger: bounce off support ' + priorLow.toFixed(2) + ', closed ' + cand.c.toFixed(2))
    base.enter = true
  } else {
    reasons.push('no setup: last close ' + cand.c.toFixed(2) + ' inside ' + priorLow.toFixed(2) + ' - ' + priorHigh.toFixed(2) + ' range')
  }
  return base
}
