// Pure technical indicator math. No side effects, fully unit-testable.

import type { Candle } from '../gemini/types.ts'

// Exponential moving average series (seeded with SMA of the first period).
// Returns an array of the same length; the first (period-1) entries are NaN.
export function ema(values: number[], period: number): number[] {
  const n = values.length
  const out = new Array<number>(n).fill(NaN)
  if (n < period || period <= 0) return out
  let seed = 0
  for (let i = 0; i < period; i++) seed += values[i]
  seed /= period
  out[period - 1] = seed
  const k = 2 / (period + 1)
  for (let i = period; i < n; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k)
  }
  return out
}

// Simple moving average series (NaN padded, same semantics as ema).
export function sma(values: number[], period: number): number[] {
  const n = values.length
  const out = new Array<number>(n).fill(NaN)
  if (n < period || period <= 0) return out
  let sum = 0
  for (let i = 0; i < period; i++) sum += values[i]
  out[period - 1] = sum / period
  for (let i = period; i < n; i++) {
    sum += values[i] - values[i - period]
    out[i] = sum / period
  }
  return out
}

// Wilder RSI. Returns series aligned to closes (first period entries are NaN).
export function rsi(closes: number[], period = 14): number[] {
  const n = closes.length
  const out = new Array<number>(n).fill(NaN)
  if (n < period + 1 || period <= 0) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1]
    const g = d > 0 ? d : 0
    const l = d < 0 ? -d : 0
    avgGain = (avgGain * (period - 1) + g) / period
    avgLoss = (avgLoss * (period - 1) + l) / period
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}

// Wilder ATR over candles. First period entries are NaN.
export function atr(candles: Candle[], period = 14): number[] {
  const n = candles.length
  const out = new Array<number>(n).fill(NaN)
  if (n < period + 1 || period <= 0) return out
  const tr: number[] = new Array<number>(n).fill(0)
  tr[0] = candles[0].h - candles[0].l
  for (let i = 1; i < n; i++) {
    const c = candles[i]
    const pc = candles[i - 1]
    tr[i] = Math.max(c.h - c.l, Math.abs(c.h - pc.c), Math.abs(c.l - pc.c))
  }
  let sum = 0
  for (let i = 1; i <= period; i++) sum += tr[i]
  out[period] = sum / period
  for (let i = period + 1; i < n; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
  }
  return out
}

// Fraction (0..1) of series values that are <= x.
export function percentileRank(series: number[], x: number): number {
  if (series.length === 0) return 0
  let count = 0
  for (const v of series) {
    if (Number.isFinite(v) && v <= x) count++
  }
  return count / series.length
}

// Pearson correlation of two equal-length series.
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 2) return 0
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]
    mb += b[i]
  }
  ma /= n
  mb /= n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma
    const y = b[i] - mb
    num += x * y
    da += x * x
    db += y * y
  }
  const den = Math.sqrt(da * db)
  return den === 0 ? 0 : num / den
}

// Simple log returns of a price series.
export function logReturns(series: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < series.length; i++) {
    if (series[i - 1] > 0 && series[i] > 0) out.push(Math.log(series[i] / series[i - 1]))
  }
  return out
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  let s = 0
  for (const v of values) s += v
  return s / values.length
}

// Highest / lowest of the last n values (exclusive of the current index).
export function highestOf(values: number[], n: number, endIndex: number): number {
  const out: number[] = []
  const from = Math.max(0, endIndex - n)
  for (let i = from; i < endIndex; i++) out.push(values[i])
  return out.length === 0 ? NaN : Math.max(...out)
}

export function lowestOf(values: number[], n: number, endIndex: number): number {
  const out: number[] = []
  const from = Math.max(0, endIndex - n)
  for (let i = from; i < endIndex; i++) out.push(values[i])
  return out.length === 0 ? NaN : Math.min(...out)
}
