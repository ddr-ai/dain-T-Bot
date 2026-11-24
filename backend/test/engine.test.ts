import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig } from '../src/config/env.ts'
import { Store } from '../src/store/store.ts'
import { CredentialsStore } from '../src/secure/credentials.ts'
import { PaperBroker } from '../src/engine/paperBroker.ts'
import { Mutex } from '../src/util/lock.ts'
import { NonceManager } from '../src/gemini/nonce.ts'

function mockCfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000, apiKey: '', apiSecret: '',
    privateBaseUrl: 'https://api.sandbox.gemini.com',
    publicBaseUrl: 'https://api.gemini.com',
    symbols: ['btcusd'],
    riskPct: 1.5, maxRiskPct: 3, dailyLossWarnPct: 3, dailyLossLimitPct: 5,
    maxConcurrent: 3, maxTradesPerSymbolPerDay: 5, setupsPer4h: 1, cooldownMinutes: 45,
    defaultRiskReward: 1.5, rrMin: 0.5, rrMax: 3, atrMult: 1.5, minStopPct: 1.5,
    maxBuyingPowerPct: 50, correlationCap: 0.85, volumeMult: 1.5,
    orderChunkThresholdUsd: 1000, trailingStop: true, breakeven: true,
    partialProfit: false, timeExitHours: 4, paper: true, paperCash: 1000,
    makerBps: 20, takerBps: 40, slipBps: 2, scanIntervalSec: 60, manageIntervalSec: 15,
    staleMs: 60000, quietFirstMinutes: 15, lowVolumeHours: [2, 6],
    minDepthUsd: 5000, maxSpreadBps: 10, minAvailableUsd: 10, rrAbort: 1.2,
    apiAuthToken: '', encryptionKey: Buffer.alloc(32, 7), dataDir: join(tmpdir(), 'dab-' + randomUUID()),
    ...over
  } as AppConfig
}

test('store persists and reloads state atomically', async () => {
  const cfg = mockCfg()
  const dir = join(tmpdir(), 'store-' + randomUUID())
  const s1 = new Store(dir, cfg)
  s1.state.settings.autopilotOn = true
  s1.state.paperBalances.usd = 777.5
  s1.addActivity('engine', 'hello')
  s1.saveNow()
  const s2 = new Store(dir, cfg)
  assert.equal(s2.state.settings.autopilotOn, true)
  assert.equal(s2.state.paperBalances.usd, 777.5)
  assert.equal(s2.state.activity.length, 1)
})

test('day rollover resets counters and anchors equity', () => {
  const cfg = mockCfg()
  const s = new Store(join(tmpdir(), 'roll-' + randomUUID()), cfg)
  s.state.daily.tradesPerSymbol['btcusd'] = 4
  s.state.daily.day = '2000-01-01' // force an out-of-date day key
  const rolled = s.rollDayIfNeeded(1234.5)
  assert.equal(rolled, true)
  assert.equal(s.state.daily.startEquity, 1234.5)
  assert.equal(Object.keys(s.state.daily.tradesPerSymbol).length, 0)
  assert.equal(s.rollDayIfNeeded(999), false)
})

test('credentials vault round-trips AES-256-GCM and never errors on wrong key', () => {
  const path = join(tmpdir(), 'creds-' + randomUUID() + '.enc')
  const good = new CredentialsStore(path, Buffer.alloc(32, 3))
  good.save({ key: 'my-api-key-123', secret: 'my-secret' })
  assert.equal(good.load()!.secret, 'my-secret')
  const wrong = new CredentialsStore(path, Buffer.alloc(32, 9))
  assert.equal(wrong.load(), undefined)
  good.clear()
})

test('credentials vault throws without ENCRYPTION_KEY', () => {
  const v = new CredentialsStore(join(tmpdir(), 'creds2-' + randomUUID() + '.enc'), undefined)
  assert.throws(() => v.save({ key: 'k', secret: 's' }), /ENCRYPTION_KEY/)
})

test('paper broker: entry, stop fill, balances', async () => {
  const cfg = mockCfg()
  const store = new Store(join(tmpdir(), 'paper-' + randomUUID()), cfg)
  let price = 100
  const broker = new PaperBroker(store, cfg, (sym) => (sym === 'btcusd' ? price : undefined))

  const entry = await broker.placeEntry('btcusd', 1, 100, 0.0001)
  assert.equal(entry.ok, true)
  assert.equal(store.state.paperBalances.coins['btcusd'], 1)
  const usdAfterEntry = store.state.paperBalances.usd
  assert.ok(usdAfterEntry < 1000, 'cash must decrease: ' + usdAfterEntry)

  const equity = await broker.equity({ btcusd: 100 })
  assert.ok(Math.abs(equity - 1000) < 0.5, 'equity close to initial after entry fee, got ' + equity)

  const stop = await broker.placeStop('btcusd', 1, 95, 100, 0.0001)
  assert.ok(stop)
  price = 94 // cross the stop
  const fills = await broker.pollFills({
    id: 'p1', symbol: 'btcusd', mode: 'paper', qty: 1, remainingQty: 1,
    entry: 100, stop: 95, target: 110, stopDist: 5, atr: 1, riskUsd: 5,
    trendAtEntry: 1, openedAt: 0, kind: 'test',
    stopOrderId: stop!.orderId, targetOrderId: null,
    breakevenDone: false, trailArmed: false, partialDone: false
  }, price)
  assert.equal(fills.length, 1)
  assert.equal(fills[0].kind, 'stop')
  assert.equal(store.state.paperBalances.coins['btcusd'], undefined, 'coin balance must be flat after stop')
  assert.ok(store.state.paperBalances.usd > usdAfterEntry)
  assert.ok(store.state.paperBalances.usd < 1000, 'loss must be realized after fees/slippage')
})

test('mutex serializes async work', async () => {
  const m = new Mutex()
  const order: number[] = []
  const task = (i: number): Promise<void> => m.run(async () => {
    order.push(i)
    await new Promise((r) => setTimeout(r, 5))
  })
  await Promise.all([task(1), task(2), task(3)])
  assert.deepEqual(order, [1, 2, 3])
})

test('nonce manager is strictly increasing under concurrency', async () => {
  const n = new NonceManager()
  const results = await Promise.all([n.next(), n.next(), n.next(), n.next()])
  const nums = results.map(Number)
  nums.sort((a, b) => a - b)
  for (let i = 1; i < nums.length; i++) {
    assert.ok(nums[i] > nums[i - 1], 'nonces must strictly increase')
  }
})
