// End-to-end tests for the Cloudflare Workers port of the engine, running
// entirely in Node (no wrangler needed): the only platform pieces are
//   * the injected engine store -> a plain Map (same contract as the
//     Durable Object's SQLite storage)
//   * the injected config bindings -> a test record
//   * fetch -> a mock Gemini public API
// so these tests exercise the same code paths the live Worker runs:
// config lazy-proxy, WebCrypto credentials, REST API routes, run window,
// and one full engine tick through the tick lock.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initEngineConfig } from '../engine/config.ts'
import { configureEngineStore, saveCreds, loadCreds } from '../engine/blobs.ts'
import type { EngineStore } from '../engine/blobs.ts'
import apiHandler from '../functions/api.ts'

const TOKEN = 'test-token-123'
const MASTER_KEY = 'unit-test-master-key'

class MapStore implements EngineStore {
  private m = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.m.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.m.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.m.delete(key)
  }
}

function resetEnv(store: EngineStore): void {
  initEngineConfig({
    API_AUTH_TOKEN: TOKEN,
    CREDS_MASTER_KEY: MASTER_KEY,
    PAPER_TRADING: 'true',
    TRADING_SYMBOLS: 'btcusd',
    GEMINI_BASE_URL: 'https://api.gemini.com'
  })
  configureEngineStore(store)
}

function req(method: string, path: string, body?: unknown, auth = true): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth) headers.Authorization = 'Bearer ' + TOKEN
  return new Request('https://engine.test' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

async function call(method: string, path: string, body?: unknown, auth = true): Promise<{ status: number, json: any }> {
  const res = await apiHandler(req(method, path, body, auth))
  return { status: res.status, json: await res.json() as any }
}

// ---- mocked Gemini public feed (ticker / candles / book / details) ----

function candleRows(): number[][] {
  const out: number[][] = []
  const now = Date.now()
  for (let i = 300; i > 0; i--) {
    const t = now - i * 300_000
    const o = 100
    out.push([t, o, 100.5, 99.5, o, 10])
  }
  return out
}

function installMockGemini(): void {
  const json = (obj: unknown, status = 200): Response =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (url: string | URL): Promise<Response> => {
    const u = String(url)
    if (u.includes('/v1/pubticker/')) {
      return json({ last: '100', bid: '99.9', ask: '100.1', volume: { BTC: '10' } })
    }
    if (u.includes('/v2/candles/')) {
      return json(candleRows())
    }
    if (u.includes('/v1/book/')) {
      return json({
        bids: [{ price: '99.9', amount: '1' }, { price: '99.8', amount: '2' }],
        asks: [{ price: '100.1', amount: '1' }, { price: '100.2', amount: '2' }]
      })
    }
    if (u.includes('/details')) {
      return json({
        symbol: 'btcusd', base_currency: 'btc', quote_currency: 'usd',
        tick_size: '0.01', quote_increment: '0.01', min_order_size: '0.00001'
      })
    }
    return json({ error: 'mock 404: ' + u }, 404)
  }
}

// ---- tests ----

test('credentials round-trip through WebCrypto AES-256-GCM store', async () => {
  resetEnv(new MapStore())
  await saveCreds({ key: 'api-key-' + 'x'.repeat(20), secret: 'api-secret-' + 'y'.repeat(20) })
  const loaded = await loadCreds()
  assert.ok(loaded, 'creds should load back')
  assert.equal(loaded.key, 'api-key-' + 'x'.repeat(20))
  assert.equal(loaded.secret, 'api-secret-' + 'y'.repeat(20))
})

test('api: health is open, everything else needs the bearer token', async () => {
  resetEnv(new MapStore())
  const health = await call('GET', '/api/health', undefined, false)
  assert.equal(health.status, 200)
  assert.equal(health.json.ok, true)

  const noAuth = await call('GET', '/api/status', undefined, false)
  assert.equal(noAuth.status, 401)

  const badToken = await call('GET', '/api/status', undefined, false)
  assert.equal(badToken.status, 401)

  const ok = await call('GET', '/api/status')
  assert.equal(ok.status, 200)
  assert.equal(ok.json.mode, 'paper')
  assert.equal(ok.json.autopilotOn, false)
  assert.equal(ok.json.runActive, false)
  assert.equal(typeof ok.json.runEndsAt, 'number')
  assert.equal(typeof ok.json.runRemainingMs, 'number')
})

test('api: settings patch + START run window opens a 120-minute run', async () => {
  resetEnv(new MapStore())
  const patched = await call('PUT', '/api/settings', { riskReward: 3.0 })
  assert.equal(patched.status, 200)
  assert.equal(patched.json.ok, true)
  assert.equal(patched.json.settings.riskReward, 3.0)

  const started = await call('POST', '/api/run', { minutes: 120 })
  assert.equal(started.status, 200)
  assert.equal(started.json.ok, true)
  assert.equal(started.json.autopilotOn, true)
  assert.equal(started.json.runMinutes, 120)
  assert.ok(started.json.runEndsAt > Date.now() - 1000)

  const status = await call('GET', '/api/status')
  assert.equal(status.json.autopilotOn, true)
  assert.equal(status.json.runActive, true)
  assert.equal(status.json.runMinutes, 120)
  assert.ok(status.json.runRemainingMs > 0)
  assert.ok(status.json.runRemainingMs <= 120 * 60_000 + 1000)

  // settings payload mirrors the Netlify shape the PWA expects
  const settings = await call('GET', '/api/settings')
  assert.equal(settings.json.runMinutes, 120)
  assert.ok(settings.json.runStartedAt > 0)
  assert.ok(settings.json.runEndsAt > 0)
  assert.equal(settings.json.riskRewardMin, 2.2)
  assert.equal(settings.json.riskRewardMax, 10)
})

test('api: out-of-range run minutes are rejected', async () => {
  resetEnv(new MapStore())
  const tooShort = await call('POST', '/api/run', { minutes: 5 })
  assert.equal(tooShort.status, 400)
  const tooLong = await call('POST', '/api/run', { minutes: 60 * 24 * 30 })
  assert.equal(tooLong.status, 400)
})

test('engine tick runs through the API with a mocked Gemini feed', async () => {
  installMockGemini()
  resetEnv(new MapStore())
  const started = await call('POST', '/api/run', { minutes: 1440 })
  assert.equal(started.status, 200)

  const tick = await call('POST', '/api/tick')
  assert.equal(tick.status, 200)
  assert.equal(tick.json.ok, true)
  assert.equal(tick.json.scanned, true)
  assert.ok(typeof tick.json.durationMs === 'number')

  // state was persisted: fresh load reflects the tick
  const activity = await call('GET', '/api/activity?limit=50')
  assert.equal(activity.status, 200)
  assert.ok(Array.isArray(activity.json) && activity.json.length > 0)

  const status = await call('GET', '/api/status')
  assert.ok(status.json.lastTickAt > 0)
  assert.equal(status.json.prices.btcusd.price, 100)

  const trades = await call('GET', '/api/trades')
  assert.equal(trades.status, 200)
  assert.ok(Array.isArray(trades.json))
})
