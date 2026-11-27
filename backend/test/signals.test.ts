import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Candle } from '../src/gemini/types.ts'
import { atrRankOK, correlationOf, correlationOK, liquidityOK, timeWindowOK } from '../src/strategy/regime.ts'
import { closedOnly, evaluateSetup, trendBiasEma } from '../src/strategy/signals.ts'

const SIGNAL_CFG = { minStopPct: 1.5 }

// Monday 5 January 2026, 00:00 UTC - a weekday session open.
const MON = Date.UTC(2026, 0, 5)
// Saturday 10 January 2026, 00:00 UTC - a weekend session open.
const SAT = Date.UTC(2026, 0, 10)
const FIVE_MIN = 300_000

// Deterministic 5m candle generator for the session ORB method: ~a day of
// pre-session "weather" candles for RSI/ATR context, then the session's
// first candle (the opening range) built from the spec, plus a forming
// second candle (dropped by closedOnly when evaluated inside the window).
function genOrb5m(sessionStart: number, first: { o: number, h: number, l: number, c: number, v?: number }, barsAfter = 1): Candle[] {
  const out: Candle[] = []
  const histBars = 300
  for (let k = 0; k < histBars; k++) {
    const t = sessionStart - (histBars - k) * FIVE_MIN
    const c = 100 + Math.sin(k / 9) * 0.8
    const o = out.length > 0 && out[out.length - 1].t === t - FIVE_MIN ? out[out.length - 1].c : c - 0.05
    out.push({ t, o, h: Math.max(o, c) + 0.3, l: Math.min(o, c) - 0.3, c, v: 1000 + 30 * (k % 5) })
  }
  out.push({ t: sessionStart, o: first.o, h: first.h, l: first.l, c: first.c, v: first.v ?? 3000 })
  let p = first.c
  for (let k = 1; k <= barsAfter; k++) {
    const t = sessionStart + k * FIVE_MIN
    const c = p + 0.1
    out.push({ t, o: p, h: Math.max(p, c) + 0.1, l: Math.min(p, c) - 0.1, c, v: 1200 })
    p = c
  }
  return out
}

// Trend-frame generator (any frame length; trendBiasEma reads closes only).
function gen5m(long: boolean): Candle[] {
  const out: Candle[] = []
  let p = 100
  for (let k = 0; k < 80; k++) {
    const c = long ? p + 0.5 : p - 0.5
    const o = p
    p = c
    out.push({ t: k * 300000, o, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2, c, v: 5000 })
  }
  return out
}

test('closedOnly drops the forming candle', () => {
  const now = Date.now()
  const closed = { t: now - 120000, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }
  const forming = { t: now - 10000, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }
  const res = closedOnly([closed, forming], 60000, now)
  assert.equal(res.length, 1)
})

test('trendBiasEma detects rising and falling markets', () => {
  assert.equal(trendBiasEma(gen5m(true)).long, true)
  assert.equal(trendBiasEma(gen5m(false)).long, false)
})

test('evaluateSetup fires ORB long on a bullish first candle in an uptrend', () => {
  const c5m = genOrb5m(MON, { o: 100, h: 101.4, l: 99.5, c: 101 })
  const now = MON + 6 * 60_000 // 00:06 UTC, inside the [5,10) entry window
  const d = evaluateSetup(c5m, gen5m(true), now, SIGNAL_CFG)
  assert.equal(d.enter, true)
  assert.equal(d.kind, 'orb')
  assert.equal(d.trendOK, true)
  // stop at the opening-range low, floored at 1.5%: max(101-99.5, 1.515)
  const expected = Math.max(101 - 99.5, 101 * 0.015)
  assert.ok(Math.abs(d.stopDist - expected) < 0.01, 'stop should sit at the range low or floor, got ' + d.stopDist)
  assert.ok(d.reasons[d.reasons.length - 1].includes('ORB'), 'reason trace should name the ORB trigger')
})

test('evaluateSetup widens thin opening ranges to the stop floor', () => {
  // range low only 0.2 below the close -> the 1.5% fee floor binds
  const c5m = genOrb5m(MON, { o: 100, h: 100.5, l: 100.2, c: 100.4 })
  const now = MON + 6 * 60_000
  const d = evaluateSetup(c5m, gen5m(true), now, SIGNAL_CFG)
  assert.equal(d.enter, true)
  const expected = 100.4 * 0.015
  assert.ok(Math.abs(d.stopDist - expected) < 0.01, 'stop should be floored at minStopPct, got ' + d.stopDist)
})

test('evaluateSetup blocks bullish first candles below the 24h trend', () => {
  // history trading around 110, first candle closes at 106: bullish but far
  // below the trailing 24h mean -> the bear filter must block the entry
  const out: Candle[] = []
  for (let k = 0; k < 300; k++) {
    const t = MON - (300 - k) * FIVE_MIN
    const c = 110 + Math.sin(k / 9) * 0.5
    const o = out.length > 0 ? out[out.length - 1].c : c - 0.05
    out.push({ t, o, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2, c, v: 1000 })
  }
  out.push({ t: MON, o: 105, h: 106.1, l: 104.9, c: 106, v: 3000 })
  out.push({ t: MON + FIVE_MIN, o: 106, h: 106.2, l: 105.9, c: 106.1, v: 1200 })
  const d = evaluateSetup(out, gen5m(true), MON + 6 * 60_000, SIGNAL_CFG)
  assert.equal(d.enter, false)
  assert.ok(d.reasons.some((r) => r.includes('below 24h trend')), 'reason should name the trend filter')
})

test('evaluateSetup blocks razor-thin opening ranges', () => {
  const c5m = genOrb5m(MON, { o: 100, h: 100.05, l: 99.98, c: 100.02 })
  const now = MON + 6 * 60_000
  const d = evaluateSetup(c5m, gen5m(true), now, SIGNAL_CFG)
  assert.equal(d.enter, false)
  assert.ok(d.reasons.some((r) => r.includes('too thin')), 'reason should name the range gate')
})

test('evaluateSetup rejects a bearish first candle (long-only engine)', () => {
  const c5m = genOrb5m(MON, { o: 101, h: 101.2, l: 99.6, c: 100 })
  const now = MON + 6 * 60_000
  const d = evaluateSetup(c5m, gen5m(true), now, SIGNAL_CFG)
  assert.equal(d.enter, false)
  assert.equal(d.kind, null)
  assert.ok(d.reasons.some((r) => r.includes('bearish')), 'reason should say the first candle was bearish')
})

test('evaluateSetup ignores flat first candles', () => {
  const c5m = genOrb5m(MON, { o: 100, h: 100.3, l: 99.7, c: 100 })
  const now = MON + 6 * 60_000
  const d = evaluateSetup(c5m, gen5m(true), now, SIGNAL_CFG)
  assert.equal(d.enter, false)
  assert.ok(d.reasons.some((r) => r.includes('flat')), 'reason should say the first candle was flat')
})

test('evaluateSetup waits for the opening range to finish forming', () => {
  const c5m = genOrb5m(MON, { o: 100, h: 101.4, l: 99.5, c: 101 })
  const now = MON + 3 * 60_000 // 00:03, first candle still forming
  const d = evaluateSetup(c5m, gen5m(true), now, SIGNAL_CFG)
  assert.equal(d.enter, false)
  assert.ok(d.reasons.some((r) => r.includes('still forming')))
})

test('evaluateSetup blocks entries outside the session entry window', () => {
  const c5m = genOrb5m(MON, { o: 100, h: 101.4, l: 99.5, c: 101 }, 10)
  const now = MON + 45 * 60_000 // 00:45, the window closed at 00:10
  const d = evaluateSetup(c5m, gen5m(true), now, SIGNAL_CFG)
  assert.equal(d.enter, false)
  assert.ok(d.reasons.some((r) => r.includes('outside session entry window')))
})

test('evaluateSetup skips weekend sessions', () => {
  const c5m = genOrb5m(SAT, { o: 100, h: 101.4, l: 99.5, c: 101 })
  const now = SAT + 6 * 60_000
  const d = evaluateSetup(c5m, gen5m(true), now, SIGNAL_CFG)
  assert.equal(d.enter, false)
  assert.ok(d.reasons.some((r) => r.includes('weekend')))
})

test('liquidityOK flags wide spreads and thin books', () => {
  const good = liquidityOK(
    {
      bids: Array.from({ length: 5 }, (_, i) => ({ price: 100 - i, amount: 60 })),
      asks: Array.from({ length: 5 }, (_, i) => ({ price: 100.01 + i, amount: 60 }))
    },
    { maxSpreadBps: 10, minDepthUsd: 5000 }
  )
  assert.ok(good.ok, 'tight book should pass: ' + JSON.stringify(good))
  assert.ok(good.spreadBps <= 10)

  const wide = liquidityOK(
    {
      bids: [{ price: 99.5, amount: 60 }],
      asks: [{ price: 101, amount: 60 }]
    },
    { maxSpreadBps: 10, minDepthUsd: 5000 }
  )
  assert.equal(wide.ok, false)
})

test('timeWindowOK blocks post-close minutes and low-volume hours', () => {
  const t0 = Date.UTC(2026, 0, 15, 14, 5, 0) // 14:05 UTC, not low-volume
  const quiet = timeWindowOK({ nowMs: t0, lowVolumeVolumeOK: false, quietMinutes: 15, lowVolumeHours: [2, 6] })
  assert.equal(quiet.ok, false) // first 15m after hourly close

  const t15 = Date.UTC(2026, 0, 15, 14, 20, 0)
  const okAt20 = timeWindowOK({ nowMs: t15, lowVolumeVolumeOK: false, quietMinutes: 15, lowVolumeHours: [2, 6] })
  assert.equal(okAt20.ok, true)

  const tNight = Date.UTC(2026, 0, 15, 3, 20, 0)
  const blocked = timeWindowOK({ nowMs: tNight, lowVolumeVolumeOK: false, quietMinutes: 15, lowVolumeHours: [2, 6] })
  assert.equal(blocked.ok, false)
  const withVol = timeWindowOK({ nowMs: tNight, lowVolumeVolumeOK: true, quietMinutes: 15, lowVolumeHours: [2, 6] })
  assert.equal(withVol.ok, true)
})

test('atrRankOK covers only the middle regime', () => {
  assert.equal(atrRankOK(0.19), false)
  assert.equal(atrRankOK(0.2), true)
  assert.equal(atrRankOK(0.9), true)
  assert.equal(atrRankOK(0.91), false)
})

test('correlation helpers', () => {
  const a: Candle[] = []
  const b: Candle[] = []
  let pa = 100
  let pb = 50
  for (let k = 0; k < 40; k++) {
    const step = k % 2 === 0 ? 1 : -0.5
    pa += step
    pb += step * 2
    a.push({ t: k * 86400000, o: pa, h: pa + 1, l: pa - 1, c: pa, v: 1 })
    b.push({ t: k * 86400000, o: pb, h: pb + 1, l: pb - 1, c: pb, v: 1 })
  }
  const corr = correlationOf(a, b)
  assert.ok(corr > 0.99, 'perfectly co-moving series should correlate, got ' + corr)
  assert.equal(correlationOK(0.86, 0.85), false)
  assert.equal(correlationOK(0.7, 0.85), true)
})
