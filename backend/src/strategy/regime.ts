// Market regime filters: volatility percentile, order-book liquidity,
// time-of-day windows, and correlation gates.

import type { OrderBook } from '../gemini/types.ts'
import type { Candle } from '../gemini/types.ts'
import { logReturns, pearson } from './indicators.ts'

export function atrRankOK(rank: number): boolean {
  // Trade neither the bottom 20% (dead) nor the top 10% (chaotic).
  return rank >= 0.2 && rank <= 0.9
}

export interface LiquidityReport {
  ok: boolean
  spreadBps: number
  depthUsd: number
}

// Spread and depth check. Depth = total notional resting within 1% of mid.
export function liquidityOK(book: OrderBook, cfg: { maxSpreadBps: number, minDepthUsd: number }): LiquidityReport {
  const bestBid = book.bids.length > 0 ? book.bids[0].price : NaN
  const bestAsk = book.asks.length > 0 ? book.asks[0].price : NaN
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
    return { ok: false, spreadBps: Infinity, depthUsd: 0 }
  }
  const mid = (bestBid + bestAsk) / 2
  const spreadBps = ((bestAsk - bestBid) / mid) * 10000
  let depthUsd = 0
  for (const lvl of book.bids) {
    if (lvl.price >= mid * 0.99) depthUsd += lvl.price * lvl.amount
  }
  for (const lvl of book.asks) {
    if (lvl.price <= mid * 1.01) depthUsd += lvl.price * lvl.amount
  }
  const ok = spreadBps <= cfg.maxSpreadBps && depthUsd >= cfg.minDepthUsd
  return { ok, spreadBps, depthUsd }
}

export interface TimeWindowInput {
  nowMs: number
  lowVolumeVolumeOK: boolean
  quietMinutes: number
  lowVolumeHours: [number, number]
}

// First N minutes after the hourly close are skipped, plus 02:00-06:00 UTC
// unless the volume confirmation already passed on the signal candle.
export function timeWindowOK(input: TimeWindowInput): { ok: boolean, reason: string } {
  const d = new Date(input.nowMs)
  if (d.getUTCMinutes() < input.quietMinutes) {
    return { ok: false, reason: 'quiet window: first ' + input.quietMinutes + 'm after hourly close' }
  }
  const h = d.getUTCHours()
  const inLow = h >= input.lowVolumeHours[0] && h < input.lowVolumeHours[1]
  if (inLow && !input.lowVolumeVolumeOK) {
    return { ok: false, reason: 'low-volume window ' + input.lowVolumeHours[0] + ':00-' + input.lowVolumeHours[1] + ':00 UTC' }
  }
  return { ok: true, reason: 'ok' }
}

// 30-day correlation of daily log returns.
export function correlationOf(candlesA: Candle[], candlesB: Candle[]): number {
  const mapA = new Map<number, number>()
  for (const c of candlesA) mapA.set(c.t, c.c)
  const a: number[] = []
  const b: number[] = []
  for (const c of candlesB) {
    const match = mapA.get(c.t)
    if (match !== undefined) {
      a.push(match)
      b.push(c.c)
    }
  }
  return pearson(logReturns(a), logReturns(b))
}

export function correlationOK(corr: number, cap: number): boolean {
  return Number.isFinite(corr) && corr < cap
}
