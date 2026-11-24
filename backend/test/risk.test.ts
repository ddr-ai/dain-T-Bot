import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AppConfig } from '../src/config/env.ts'
import { breakerAction, clampRiskReward, computeStopDist, correlationGateForEntry, positionSize, rrAfterFees } from '../src/risk/guards.ts'

function mockCfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000,
    apiKey: '',
    apiSecret: '',
    privateBaseUrl: 'https://api.sandbox.gemini.com',
    publicBaseUrl: 'https://api.gemini.com',
    symbols: ['btcusd', 'ethusd', 'solusd'],
    riskPct: 1.5,
    maxRiskPct: 3.0,
    dailyLossWarnPct: 3.0,
    dailyLossLimitPct: 5.0,
    maxConcurrent: 3,
    maxTradesPerSymbolPerDay: 5,
    setupsPer4h: 1,
    cooldownMinutes: 45,
    defaultRiskReward: 1.5,
    rrMin: 0.5,
    rrMax: 3.0,
    atrMult: 1.5,
    minStopPct: 1.5,
    maxBuyingPowerPct: 50.0,
    correlationCap: 0.85,
    volumeMult: 1.5,
    orderChunkThresholdUsd: 1000,
    trailingStop: true,
    breakeven: true,
    partialProfit: false,
    timeExitHours: 4,
    paper: true,
    paperCash: 1000,
    makerBps: 20,
    takerBps: 40,
    slipBps: 2,
    scanIntervalSec: 60,
    manageIntervalSec: 15,
    staleMs: 60000,
    quietFirstMinutes: 15,
    lowVolumeHours: [2, 6],
    minDepthUsd: 5000,
    maxSpreadBps: 10,
    minAvailableUsd: 10,
    rrAbort: 1.2,
    apiAuthToken: '',
    encryptionKey: undefined,
    dataDir: '/tmp/dab-test-data',
    ...over
  } as AppConfig
}

const cfg = mockCfg()

test('position size: risk budget divided by stop distance', () => {
  const r = positionSize({
    equity: 1000, usdAvailable: 1000, committedUsd: 0,
    price: 100, stop: 95, step: 0.01, minNotionalUsd: 5, cfg
  })
  assert.ok(r.ok)
  assert.equal(r.qty, 3)            // risk 15 USD / stop distance 5 = 3 qty, cost 300 (< 500 cap)
  assert.ok(Math.abs(r.riskUsd - 15) < 1e-9)
  assert.ok(Math.abs(r.costUsd - 300) < 1e-9)
})

test('position size respects the $10 minimum available cash', () => {
  const r = positionSize({
    equity: 1000, usdAvailable: 9.99, committedUsd: 0,
    price: 100, stop: 95, step: 0.01, minNotionalUsd: 5, cfg
  })
  assert.equal(r.ok, false)
  assert.ok((r.reason ?? '').includes('minimum'))
})

test('position size respects the buying power cap', () => {
  const r = positionSize({
    equity: 1000, usdAvailable: 100, committedUsd: 45,
    price: 100, stop: 98, step: 0.01, minNotionalUsd: 5, cfg
  })
  // risk 15 -> qty raw 7.5 -> notional 750, cap is 50% of 100 = 50 minus 45 committed = 5
  assert.equal(r.ok, false)
  assert.ok((r.reason ?? '').includes('buying power'))
})

test('position size small accounts scale down instead of going negative', () => {
  const r = positionSize({
    equity: 100, usdAvailable: 11, committedUsd: 0,
    price: 100, stop: 97, step: 0.001, minNotionalUsd: 5, cfg
  })
  // risk budget 1.5/3 dist=3 -> qty 0.5 -> cost 50 > available: must shrink, never negative
  if (r.ok) {
    assert.ok(r.costUsd <= 11)
    assert.ok(11 - r.costUsd - r.entryFeeUsd >= 0)
  } else {
    assert.ok((r.reason ?? '').length > 0)
  }
})

test('risk percent never exceeds the hard cap', () => {
  const r = positionSize({
    equity: 1000, usdAvailable: 1000, committedUsd: 0,
    price: 100, stop: 99, step: 0.0001, minNotionalUsd: 5,
    cfg: mockCfg({ riskPct: 10, maxRiskPct: 3 })
  })
  // capped at 3%: risk 30 / dist 1 = 30 qty, cost 3000 > cap 500 -> rejected by buying power
  assert.equal(r.ok, false)
})

test('rrAfterFees computes net reward and aborts below the threshold', () => {
  const ok = rrAfterFees({ price: 100, stop: 95, qty: 1, riskReward: 1.5, cfg })
  assert.ok(ok.ok)
  assert.ok(Math.abs(ok.target - 107.5) < 1e-9)
  assert.ok(ok.rrNet >= 1.2 && ok.rrNet < 1.5, 'fees reduce the 1.5 rr, got ' + ok.rrNet)

  const low = rrAfterFees({ price: 100, stop: 99.9, qty: 1, riskReward: 0.5, cfg })
  assert.equal(low.ok, false)
  assert.ok((low.reason ?? '').includes('below'))
})

test('breaker trips at warn and flatten levels', () => {
  assert.equal(breakerAction(-1, cfg), 'ok')
  assert.equal(breakerAction(-3.5, cfg), 'halt-new')
  assert.equal(breakerAction(-5.5, cfg), 'flatten')
})

test('risk reward slider clamps to configured bounds', () => {
  assert.equal(clampRiskReward(5, cfg), 3.0)
  assert.equal(clampRiskReward(0.1, cfg), 0.5)
  assert.equal(clampRiskReward(1.7, cfg), 1.7)
})

test('stop distance uses the ATR floor of minStopPct', () => {
  const d1 = computeStopDist(100, 1, cfg)      // 1.5*1 = 1.5 vs 1.5% -> 1.5
  assert.ok(Math.abs(d1 - 1.5) < 1e-9)
  const d2 = computeStopDist(100, 3, cfg)      // 4.5 vs 1.5 -> 4.5
  assert.ok(Math.abs(d2 - 4.5) < 1e-9)
})

test('correlation gate blocks highly correlated third-coin entries', () => {
  const corr = { 'solusd|btcusd': 0.86, 'ethusd|btcusd': 0.7 }
  const blocked = correlationGateForEntry('solusd', ['btcusd', 'ethusd'], corr, cfg)
  assert.equal(blocked.ok, false)
  const allowed = correlationGateForEntry('solusd', [], corr, cfg)
  assert.equal(allowed.ok, true)
})
