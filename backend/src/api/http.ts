// REST API for the iOS app and the PWA. Plain node:http, zero dependencies.
// If API_AUTH_TOKEN is configured, all non-GET/health endpoints require
// "Authorization: Bearer <token>".

import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http'
import type { AppConfig } from '../config/env.ts'
import type { Autopilot } from '../engine/autopilot.ts'
import type { CredentialsStore } from '../secure/credentials.ts'
import type { Store, TradeDoc } from '../store/store.ts'

export interface ApiDeps {
  cfg: AppConfig
  store: Store
  engine: Autopilot
  creds: CredentialsStore
}

interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  body: Record<string, unknown>
  query: URLSearchParams
}

type Handler = (ctx: Ctx) => Promise<unknown>

interface Route {
  method: string
  path: string
  handler: Handler
}

function json(res: ServerResponse, code: number, obj: unknown): void {
  const data = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  })
  res.end(data)
}

function error(res: ServerResponse, code: number, msg: string): void {
  json(res, code, { error: msg })
}

function computedPerformance(store: Store): Record<string, unknown> {
  const closed = store.state.trades.filter((t) => t.status === 'closed')
  const wins = closed.filter((t) => t.pnlUsd > 0)
  const losses = closed.filter((t) => t.pnlUsd <= 0)
  const grossWin = wins.reduce((s, t) => s + t.pnlUsd, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0))
  const fees = closed.reduce((s, t) => s + t.feesUsd, 0)
  let equity = 0
  let peak = 0
  let maxDD = 0
  const curve: number[] = []
  for (const t of closed.slice().sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))) {
    equity += t.pnlUsd
    if (equity > peak) peak = equity
    const dd = peak - equity
    if (dd > maxDD) maxDD = dd
    curve.push(equity)
  }
  const today = store.state.daily
  return {
    trades: closed.length,
    openTrades: store.state.trades.length - closed.length,
    winRate: closed.length === 0 ? null : wins.length / closed.length,
    profitFactor: grossLoss === 0 ? null : grossWin / grossLoss,
    avgWin: wins.length === 0 ? null : grossWin / wins.length,
    avgLoss: losses.length === 0 ? null : grossLoss / losses.length,
    totalPnl: closed.reduce((s, t) => s + t.pnlUsd, 0),
    maxDrawdown: maxDD,
    feesPaid: fees,
    todayRealized: today.realizedPnl - today.realizedFees,
    todayFees: today.realizedFees,
    equityCurve: curve.slice(-100)
  }
}

export function buildRoutes(deps: ApiDeps): Route[] {
  const { store, engine, creds, cfg } = deps

  const requireAuth = (req: IncomingMessage): boolean => {
    if (!cfg.apiAuthToken) return true
    const h = req.headers.authorization ?? ''
    return h === 'Bearer ' + cfg.apiAuthToken
  }

  const routes: Route[] = []

  // Every route except GET /api/health needs the bearer token when configured.
  const route = (method: string, path: string, handler: Handler): void => {
    const needsAuth = !(method === 'GET' && path === '/api/health')
    const wrapped: Handler = async (ctx) => {
      if (needsAuth && !requireAuth(ctx.req)) {
        throw { status: 401, message: 'missing or invalid Authorization bearer token' }
      }
      return handler(ctx)
    }
    routes.push({ method, path, handler: wrapped })
  }

  route('GET', '/api/health', async () => ({ ok: true, ts: Date.now() }))

  route('GET', '/api/status', async () => engine.status())

  route('POST', '/api/autopilot', async ({ body }) => {
    const enabled = body.enabled === true || body.enabled === 'true'
    engine.setAutopilot(enabled)
    return { ok: true, autopilotOn: enabled }
  })

  route('GET', '/api/settings', async () => {
    const s = store.state.settings
    return { ...s, riskRewardMin: cfg.rrMin, riskRewardMax: cfg.rrMax, maxRiskPct: cfg.maxRiskPct, symbols: cfg.symbols }
  })

  route('PUT', '/api/settings', async ({ body }) => {
    const r = engine.updateSettings(body)
    if (!r.ok) throw { status: 400, message: r.error }
    return { ok: true, settings: { ...store.state.settings } }
  })

  route('POST', '/api/credentials', async ({ body }) => {
    const key = String(body.key ?? '')
    const secret = String(body.secret ?? '')
    if (key.length < 10 || secret.length < 10) throw { status: 400, message: 'key and secret look invalid' }
    creds.save({ key, secret })
    store.addActivity('security', 'Gemini credentials updated (stored AES-256-GCM encrypted at rest)')
    return { ok: true }
  })

  route('DELETE', '/api/credentials', async () => {
    creds.clear()
    store.addActivity('security', 'Gemini credentials removed from this backend')
    return { ok: true }
  })

  route('GET', '/api/positions', async () => {
    const priceMap: Record<string, number> = {}
    return store.state.positions.map((p) => {
      const price = engine.priceOf(p.symbol)
      if (price) priceMap[p.symbol] = price
      return { ...p, currentPrice: price ?? null, unrealizedPnl: price !== undefined ? (price - p.entry) * p.remainingQty : null }
    })
  })

  route('GET', '/api/trades', async ({ query }) => {
    const limit = Math.max(1, Math.min(500, Number(query.get('limit') ?? 50) || 50))
    const all: TradeDoc[] = store.state.trades
    return all.slice(0, limit)
  })

  route('GET', '/api/activity', async ({ query }) => {
    const limit = Math.max(1, Math.min(500, Number(query.get('limit') ?? 80) || 80))
    return store.state.activity.slice(-limit).reverse()
  })

  route('GET', '/api/performance', async () => computedPerformance(store))

  route('GET', '/api/prices', async () => {
    const out: Record<string, unknown> = {}
    const status = await engine.status()
    const prices = (status as Record<string, unknown>).prices as Record<string, { price: number, at: number }>
    for (const [k, v] of Object.entries(prices ?? {})) out[k] = v
    return out
  })

  route('GET', '/api/correlations', async () => engine.correlationsSnapshot())

  route('POST', '/api/emergency-stop', async () => {
    await engine.emergencyStop('user triggered from app')
    return { ok: true }
  })

  return routes
}

export function createHttpServer(deps: ApiDeps): Server {
  const routes = buildRoutes(deps)

  const server = createServer(async (req, res) => {
    const started = Date.now()
    try {
      const u = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '86400'
        })
        res.end()
        return
      }
      // read body
      let bodyRaw = ''
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
        bodyRaw = await new Promise<string>((resolve, reject) => {
          let acc = ''
          req.on('data', (chunk: Buffer) => {
            acc += chunk.toString('utf8')
            if (acc.length > 1024 * 1024) {
              reject(new Error('body too large'))
              req.destroy()
            }
          })
          req.on('end', () => resolve(acc))
          req.on('error', reject)
        })
      }
      let body: Record<string, unknown> = {}
      if (bodyRaw.length > 0) {
        try {
          body = JSON.parse(bodyRaw) as Record<string, unknown>
        } catch {
          return error(res, 400, 'invalid JSON body')
        }
      }
      const match = routes.find((r) => r.method === req.method && r.path === u.pathname)
      if (!match) {
        return error(res, 404, 'not found: ' + req.method + ' ' + u.pathname)
      }
      const result = await match.handler({ req, res, body, query: u.searchParams })
      if (!res.writableEnded) json(res, 200, result)
      void started
    } catch (e) {
      const err = e as { status?: number, message?: string }
      const code = typeof err.status === 'number' ? err.status : 500
      if (code >= 500) {
        console.error('[' + new Date().toISOString() + '] [ERROR] api: ' + String(err.message))
      }
      if (!res.writableEnded) error(res, code, err.message ?? 'internal error')
    }
  })

  return server
}
