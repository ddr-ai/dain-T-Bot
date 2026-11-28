// REST API for the PWA, served from the Cloudflare Workers engine (ported
// from netlify/functions/api.ts). Route-compatible with the standalone backend
// (backend/src/api/http.ts) so both clients work unchanged, plus the
// run-window flow:
//   POST /api/run {minutes}  -> START (autopilot on + run window 1h..7d)
//   POST /api/autopilot {enabled:false} -> STOP (entries stop, positions managed)
// Auth: when the API_AUTH_TOKEN secret is set on the Worker, every route
// except GET /api/health requires "Authorization: Bearer <token>".

import { CONFIG, RUN_MINUTES_MIN, RUN_MINUTES_MAX, RUN_MINUTES_DEFAULT } from '../engine/config.ts'
import {
  loadState, saveState, loadCreds, saveCreds, clearCreds
} from '../engine/blobs.ts'
import type { ServerlessState, TradeDoc } from '../engine/state.ts'
import { addActivity, runEndsAt, runActive, seedDaily } from '../engine/state.ts'
import { engineTick } from '../engine/tick.ts'
import { emergencyStop } from '../engine/manager.ts'
import type { TickContext } from '../engine/manager.ts'
import { priceOf } from '../engine/gemini.ts'
import { paperEquity } from '../engine/brokers.ts'

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store'
}

const json = (code: number, obj: unknown): Response =>
  new Response(JSON.stringify(obj), { status: code, headers: JSON_HEADERS })

const err = (code: number, msg: string): Response => json(code, { error: msg })

async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  try {
    const raw = await req.text()
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function authorized(req: Request): boolean {
  const token = CONFIG.apiAuthToken
  if (!token) return true
  return (req.headers.get('authorization') ?? '') === 'Bearer ' + token
}

function settingsPayload(st: ServerlessState): Record<string, unknown> {
  return {
    ...st.settings,
    runMinutes: st.run.minutes,
    runStartedAt: st.run.startedAt,
    runEndsAt: runEndsAt(st),
    riskRewardMin: CONFIG.rrMin,
    riskRewardMax: CONFIG.rrMax,
    maxRiskPct: CONFIG.maxRiskPct,
    symbols: CONFIG.symbols
  }
}

function statusPayload(st: ServerlessState, hasCredentials: boolean): Record<string, unknown> {
  const mode = st.settings.paper ? 'paper' : 'live'
  const endsAt = runEndsAt(st)
  let unrealized = 0
  const positions = st.positions.map((p) => {
    const price = priceOf(st, p.symbol)
    const upnl = price ? (price - p.entry) * p.remainingQty : null
    unrealized += upnl ?? 0
    return { ...p, currentPrice: price ?? null, unrealizedPnl: upnl }
  })
  const pnlToday = st.daily.realizedPnl - st.daily.realizedFees + unrealized
  const prices: Record<string, { price: number, at: number }> = { ...st.prices }
  const now = Date.now()
  const equity = st.equitySnap.at > 0 ? st.equitySnap.equity : (mode === 'paper' ? paperEquity(st) : 0)
  return {
    running: true,
    autopilotOn: st.settings.autopilotOn,
    mode,
    hasCredentials,
    equity,
    usdAvailable: st.equitySnap.at > 0 ? st.equitySnap.usdAvailable : (mode === 'paper' ? st.paperBalances.usd : 0),
    pnlToday,
    pnlTodayPct: st.daily.startEquity > 0 ? (pnlToday / st.daily.startEquity) * 100 : 0,
    dayStartEquity: st.daily.startEquity,
    haltNew: st.daily.haltNew,
    haltReason: st.daily.haltReason,
    guardLock: st.daily.guardLock,
    lastScanAt: st.lastScanAt,
    lastTickAt: st.lastTickAt,
    stalePrices: CONFIG.symbols.filter((s) => !st.prices[s] || now - st.prices[s].at > CONFIG.staleMs),
    positions,
    prices,
    runActive: runActive(st) && st.settings.autopilotOn,
    runStartedAt: st.run.startedAt,
    runEndsAt: endsAt,
    runMinutes: st.run.minutes,
    runRemainingMs: endsAt > 0 && now < endsAt ? endsAt - now : 0
  }
}

function performancePayload(st: ServerlessState): Record<string, unknown> {
  const closed = st.trades.filter((t) => t.status === 'closed')
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
  return {
    trades: closed.length,
    openTrades: st.trades.length - closed.length,
    winRate: closed.length === 0 ? null : wins.length / closed.length,
    profitFactor: grossLoss === 0 ? null : grossWin / grossLoss,
    avgWin: wins.length === 0 ? null : grossWin / wins.length,
    avgLoss: losses.length === 0 ? null : grossLoss / losses.length,
    totalPnl: closed.reduce((s, t) => s + t.pnlUsd, 0),
    maxDrawdown: maxDD,
    feesPaid: fees,
    todayRealized: st.daily.realizedPnl - st.daily.realizedFees,
    todayFees: st.daily.realizedFees,
    equityCurve: curve.slice(-100)
  }
}

// ---- settings patch (ported from Autopilot.updateSettings 1:1) ----

async function patchSettings(st: ServerlessState, patch: Record<string, unknown>): Promise<string | undefined> {
  const s = st.settings
  if (patch.riskReward !== undefined) {
    const v = Number(patch.riskReward)
    if (!Number.isFinite(v)) return 'riskReward must be a number'
    s.riskReward = Math.min(CONFIG.rrMax, Math.max(CONFIG.rrMin, v))
  }
  if (patch.riskPct !== undefined) {
    const v = Number(patch.riskPct)
    if (!Number.isFinite(v) || v <= 0 || v > CONFIG.maxRiskPct) return 'riskPct must be in (0, ' + CONFIG.maxRiskPct + ']'
    s.riskPct = v
  }
  if (patch.maxTradesPerSymbolPerDay !== undefined) {
    const v = Number(patch.maxTradesPerSymbolPerDay)
    if (!Number.isInteger(v) || v < 1 || v > CONFIG.maxTradesPerSymbolPerDay) return 'maxTradesPerSymbolPerDay must be an integer in [1, ' + CONFIG.maxTradesPerSymbolPerDay + ']'
    s.maxTradesPerSymbolPerDay = v
  }
  if (patch.dailyLossWarnPct !== undefined) {
    const v = Number(patch.dailyLossWarnPct)
    if (!Number.isFinite(v) || v <= 0 || v > 10) return 'dailyLossWarnPct must be in (0, 10]'
    s.dailyLossWarnPct = v
  }
  if (patch.dailyLossLimitPct !== undefined) {
    const v = Number(patch.dailyLossLimitPct)
    if (!Number.isFinite(v) || v <= s.dailyLossWarnPct || v > 15) return 'dailyLossLimitPct must be > warn and <= 15'
    s.dailyLossLimitPct = v
  }
  for (const flag of ['notifyFills', 'notifyStops', 'notifyBreaker'] as const) {
    if (patch[flag] !== undefined) {
      if (typeof patch[flag] !== 'boolean') return flag + ' must be boolean'
      s[flag] = patch[flag] as boolean
    }
  }
  if (patch.paper !== undefined) {
    if (typeof patch.paper !== 'boolean') return 'paper must be boolean'
    if (patch.paper !== s.paper) {
      if (st.positions.length > 0) return 'switch paper/live mode only with NO open positions (run emergency stop first)'
      s.paper = patch.paper
      addActivity(st, 'engine', 'Mode switched to ' + (s.paper ? 'PAPER' : 'LIVE') + ' trading')
      st.equitySnap = { at: 0, equity: 0, usdAvailable: 0 }
      st.daily = seedDaily(s.paper ? CONFIG.paperCash : 0)
    }
  }
  if (patch.minutes !== undefined || patch.runMinutes !== undefined) {
    const v = Number(patch.minutes ?? patch.runMinutes)
    if (!Number.isFinite(v)) return 'minutes must be a number'
    st.run.minutes = Math.min(RUN_MINUTES_MAX, Math.max(RUN_MINUTES_MIN, Math.round(v)))
  }
  return undefined
}

// START the run: autopilot on + run window anchored to now.
async function startRun(st: ServerlessState, minutes: number): Promise<void> {
  st.run.minutes = Math.min(RUN_MINUTES_MAX, Math.max(RUN_MINUTES_MIN, Math.round(minutes) || RUN_MINUTES_DEFAULT))
  st.run.startedAt = Date.now()
  st.settings.autopilotOn = true
  st.daily.guardLock = false // manual re-enable resets a tripped breaker
  addActivity(st, 'engine', 'RUN STARTED: autopilot ON for ' + (st.run.minutes / 60).toFixed(1) + 'h (' + st.run.minutes + ' min), mode ' + (st.settings.paper ? 'PAPER' : 'LIVE') + '. Open positions keep being managed after the window ends.')
}

export default async (req: Request): Promise<Response> => {
  const u = new URL(req.url)
  // Some HTTP clients (e.g. iOS Foundation URL building) percent-encode the
  // '?' of a query string into the path ("/api/activity%3Flimit=60").
  // Decode and re-split so those requests still route correctly.
  let rawPath = u.pathname
  let search = u.search
  if (rawPath.includes('%3F') || rawPath.includes('%3f')) {
    const decoded = decodeURIComponent(rawPath)
    const q = decoded.indexOf('?')
    if (q >= 0) {
      rawPath = decoded.slice(0, q)
      search = decoded.slice(q)
    } else {
      rawPath = decoded
    }
  }
  const path = rawPath.replace(/\/+$/, '') || '/api'
  const method = req.method.toUpperCase()
  const query = new URLSearchParams(search)

  if (method === 'OPTIONS') return new Response('', { status: 204, headers: JSON_HEADERS })
  if (path === '/api/health') return json(200, { ok: true, ts: Date.now() })

  if (!authorized(req)) return err(401, 'missing or invalid Authorization bearer token')

  try {
    // ---- routes that do not need state first ----
    if (method === 'POST' && path === '/api/tick') {
      const r = await engineTick()
      return json(200, { ok: true, ...r })
    }

    const st = await loadState()

    if (method === 'GET' && path === '/api/status') {
      const creds = await loadCreds()
      return json(200, statusPayload(st, creds !== undefined))
    }
    if (method === 'GET' && path === '/api/settings') {
      return json(200, settingsPayload(st))
    }
    if (method === 'PUT' && path === '/api/settings') {
      const e = await patchSettings(st, await bodyOf(req))
      if (e) return err(400, e)
      await saveState(st)
      return json(200, { ok: true, settings: settingsPayload(st) })
    }
    if (method === 'POST' && path === '/api/settings') {
      const e = await patchSettings(st, await bodyOf(req))
      if (e) return err(400, e)
      await saveState(st)
      return json(200, { ok: true, settings: settingsPayload(st) })
    }
    if (method === 'POST' && path === '/api/run') {
      const body = await bodyOf(req)
      const minutes = Number(body.minutes ?? body.duration ?? RUN_MINUTES_DEFAULT)
      if (!Number.isFinite(minutes) || minutes < RUN_MINUTES_MIN || minutes > RUN_MINUTES_MAX) {
        return err(400, 'minutes must be between ' + RUN_MINUTES_MIN + ' and ' + RUN_MINUTES_MAX)
      }
      await startRun(st, minutes)
      await saveState(st)
      return json(200, { ok: true, autopilotOn: true, runMinutes: st.run.minutes, runEndsAt: runEndsAt(st) })
    }
    if (method === 'POST' && path === '/api/autopilot') {
      const body = await bodyOf(req)
      const enabled = body.enabled === true || body.enabled === 'true'
      st.settings.autopilotOn = enabled
      if (enabled && st.run.startedAt === 0) {
        st.run.startedAt = Date.now() // toggle without a prior run: default window
      }
      if (enabled) st.daily.guardLock = false
      addActivity(st, 'engine', enabled ? 'Autopilot turned ON (manual reset)' : 'Autopilot turned OFF - positions still managed until closed')
      await saveState(st)
      return json(200, { ok: true, autopilotOn: enabled })
    }
    if (method === 'POST' && path === '/api/credentials') {
      // Parse inline (not via bodyOf) so a rejected save can report exactly
      // what arrived - field lengths, raw byte count, parse failures.
      const raw = await req.text().catch(() => '')
      let body: Record<string, unknown> = {}
      let parseFailed = false
      try {
        const parsed = raw ? JSON.parse(raw) : {}
        if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
        else parseFailed = true
      } catch {
        parseFailed = true
      }
      const key = String(body.key ?? '').trim()
      const secret = String(body.secret ?? '').trim()
      if (key.length < 8 || secret.length < 8) {
        const why = 'Gemini key rejected: received key length ' + key.length +
          ', secret length ' + secret.length + ', raw body ' + raw.length + ' bytes' +
          (parseFailed ? ' (body did not parse as JSON)' : '') +
          ', fields: ' + Object.keys(body).join(',')
        addActivity(st, 'error', why)
        await saveState(st)
        return err(400, why)
      }
      await saveCreds({ key, secret })
      addActivity(st, 'security', 'Gemini credentials saved (AES-256-GCM encrypted)')
      await saveState(st)
      return json(200, { ok: true })
    }
    if (method === 'DELETE' && path === '/api/credentials') {
      await clearCreds()
      addActivity(st, 'security', 'Gemini credentials removed from this backend')
      await saveState(st)
      return json(200, { ok: true })
    }
    if (method === 'GET' && path === '/api/positions') {
      const out = st.positions.map((p) => {
        const price = priceOf(st, p.symbol)
        return { ...p, currentPrice: price ?? null, unrealizedPnl: price !== undefined ? (price - p.entry) * p.remainingQty : null }
      })
      return json(200, out)
    }
    if (method === 'GET' && path === '/api/trades') {
      const limit = Math.max(1, Math.min(500, Number(query.get('limit') ?? 50) || 50))
      return json(200, st.trades.slice(0, limit))
    }
    if (method === 'GET' && path === '/api/activity') {
      const limit = Math.max(1, Math.min(500, Number(query.get('limit') ?? 80) || 80))
      return json(200, st.activity.slice(-limit).reverse())
    }
    if (method === 'GET' && path === '/api/performance') {
      return json(200, performancePayload(st))
    }
    if (method === 'GET' && path === '/api/prices') {
      return json(200, st.prices)
    }
    if (method === 'GET' && path === '/api/correlations') {
      return json(200, st.corr)
    }
    if (method === 'POST' && path === '/api/emergency-stop') {
      const creds = await loadCreds()
      const ctx: TickContext = { st, creds }
      await emergencyStop(ctx, 'user triggered from app')
      await saveState(st)
      return json(200, { ok: true })
    }

    return err(404, 'not found: ' + method + ' ' + path)
  } catch (e) {
    return err(500, 'engine api error: ' + String((e as Error).message))
  }
}
