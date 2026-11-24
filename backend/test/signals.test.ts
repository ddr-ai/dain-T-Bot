import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Candle } from '../src/gemini/types.ts'
import { atrRankOK, correlationOf, correlationOK, liquidityOK, timeWindowOK } from '../src/strategy/regime.ts'
import { closedOnly, evaluateSetup, trendBias1h } from '../src/strategy/signals.ts'

const SIGNAL_CFG = { atrMult: 1.5, minStopPct: 1.5, volumeMult: 1.5 }

// Deterministic candle generator: 240 candles of moderate sine "weather",
// then a 20-candle quiet consolidation just below resistance, and finally
// (style=breakout) a volume-confirmed breakout candle above the range high.
function gen15m(style: 'breakout' | 'range'): Candle[] {
  const out: Candle[] = []
  for (let k = 0; k < 260; k++) {
    if (k < 240) {
      const amp = 0.4 + 0.2 * Math.sin(k / 17)
      const c = 100 + 0.02 * k + 1.2 * Math.sin(k / 9)
      const o = out.length > 0 ? out[out.length - 1].c : c - 0.1
      out.push({ t: k * 900000, o, h: Math.max(o, c) + amp, l: Math.min(o, c) - amp, c, v: 1000 + 40 * (k % 7) })
    } else {
      const base = out[out.length - 1].c
      const c = base + (k % 2 === 0 ? 0.25 : -0.25)
      out.push({ t: k * 900000, o: base, h: Math.max(base, c) + 0.1, l: Math.min(base, c) - 0.1, c, v: 1000 })
    }
  }
  if (style === 'breakout') {
    const last = out.length - 1
    const priorHigh = Math.max(...out.slice(last - 16, last).map((x) => x.h))
    const cPrev = out[last - 1].c // previous close sits at the range floor by construction
    out[last] = { t: out[last].t, o: cPrev, h: priorHigh + 0.4, l: cPrev - 0.1, c: priorHigh + 0.08, v: 3200 }
  }
  return out
}

function gen1h(long: boolean): Candle[] {
  const out: Candle[] = []
  let p = 100
  for (let k = 0; k < 80; k++) {
    const c = long ? p + 0.5 : p - 0.5
    const o = p
    p = c
    out.push({ t: k * 3600000, o, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2, c, v: 5000 })
  }
  return out
}

test('closedOnly drops the forming candle', () => {
  const now = Date.now()
  const closed = { t: now - 2000000, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }
  const forming = { t: now - 10000, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }
  const res = closedOnly([closed, forming], 900000, now)
  assert.equal(res.length, 1)
})

test('trendBias1h detects rising and falling markets', () => {
  assert.equal(trendBias1h(gen1h(true)).long, true)
  assert.equal(trendBias1h(gen1h(false)).long, false)
})

test('evaluateSetup fires on a crafted breakout', () => {
  const c15 = gen15m('breakout')
  const c1h = gen1h(true)
  const nowMs = c15[c15.length - 1].t + 900000 // one full frame later = closed
  const d = evaluateSetup(c15, c1h, nowMs, SIGNAL_CFG)
  assert.equal(d.enter, true)
  assert.equal(d.kind, 'breakout')
  assert.ok(d.rsi > 30 && d.rsi < 70, 'RSI should stay neutral, got ' + d.rsi)
  assert.ok(d.atrRank >= 0.2 && d.atrRank <= 0.9, 'ATR rank should be mid band, got ' + d.atrRank)
  assert.ok(d.stopDist > 0)
})

test('evaluateSetup rejects a quiet range without a breakout', () => {
  const c15 = gen15m('range')
  const c1h = gen1h(true)
  const nowMs = c15[c15.length - 1].t + 900000
  const d = evaluateSetup(c15, c1h, nowMs, SIGNAL_CFG)
  // final candle volume is normal, no trigger: no entry
  assert.equal(d.enter, false)
})

test('evaluateSetup blocks wrong-side trend', () => {
  const c15 = gen15m('breakout')
  const c1h = gen1h(false) // 1h downtrend
  const nowMs = c15[c15.length - 1].t + 900000
  const d = evaluateSetup(c15, c1h, nowMs, SIGNAL_CFG)
  assert.equal(d.enter, false)
  assert.equal(d.trendOK, false)
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
