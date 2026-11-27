// The scan loop of the serverless engine - a faithful port of
// backend/src/engine/autopilot.ts scanOnce/scanSymbol. Runs once per engine
// tick (every minute). All hard risk gates are enforced before entry, using
// the SAME tested code from backend/src/risk/guards.ts and
// backend/src/strategy/* imported directly.

import { bucket4h, dayKey } from '../../backend/src/util/time.ts'
import { evaluateSetup } from '../../backend/src/strategy/signals.ts'
import { liquidityOK, timeWindowOK, correlationOf } from '../../backend/src/strategy/regime.ts'
import { breakerAction, positionSize, rrAfterFees, clampRiskReward, correlationGateForEntry } from '../../backend/src/risk/guards.ts'
import type { AppConfig } from '../../backend/src/config/env.ts'
import { CONFIG } from './config.ts'
import type { ServerlessState, PositionDoc } from './state.ts'
import { addActivity, addTrade, nextId, runEndsAt } from './state.ts'
import type { GeminiCreds } from './blobs.ts'
import { ticker, candles, book, details, priceOf } from './gemini.ts'
import { paperEntry, paperEquity, liveEntry, liveUsdAvailable, liveEquity } from './brokers.ts'
import type { TickContext } from './manager.ts'
import { ensureProtectiveOrders } from './manager.ts'

// effective config: per-user adjustable breaker levels from settings
function effCfg(st: ServerlessState): AppConfig {
  return { ...CONFIG, dailyLossWarnPct: st.settings.dailyLossWarnPct, dailyLossLimitPct: st.settings.dailyLossLimitPct } as AppConfig
}

export async function scan(ctx: TickContext): Promise<void> {
  const st = ctx.st
  const cfg = effCfg(st)
  const settings = st.settings
  const daily = st.daily
  st.lastScanAt = Date.now()

  // 0. Run window: the user-started run has ended -> stop NEW entries.
  //    Open positions KEEP being managed every tick (user's choice).
  const endsAt = runEndsAt(st)
  if (settings.autopilotOn && st.run.startedAt > 0 && endsAt > 0 && Date.now() >= endsAt) {
    settings.autopilotOn = false
    addActivity(st, 'engine', 'Run window ended (' + Math.round(st.run.minutes / 60) + 'h). New entries stopped; open positions keep being managed until closed.')
  }

  // 1. Refresh prices from the public REST feed (serverless: no raw socket).
  await Promise.allSettled(
    CONFIG.symbols.map(async (symbol) => {
      try {
        const t = await ticker(symbol)
        if (Number.isFinite(t.last) && t.last > 0) {
          st.prices[symbol] = { price: t.last, at: Date.now() }
        }
      } catch {
        // ticker hiccup: keep the last known price, staleness gate protects us
      }
    })
  )

  const mode: 'paper' | 'live' = settings.paper ? 'paper' : 'live'
  if (mode === 'live' && !ctx.creds) {
    addActivity(st, 'skip', 'LIVE mode wants to trade but no Gemini key is saved yet. Add your key in the app Settings to go live.')
    return
  }

  // 2. Equity snapshot.
  let equity = 0
  let usdAvailable = 0
  if (mode === 'paper') {
    equity = paperEquity(st)
    usdAvailable = st.paperBalances.usd
  } else if (ctx.creds) {
    try {
      equity = await liveEquity(st, ctx.creds)
      usdAvailable = await liveUsdAvailable(ctx.creds)
    } catch (e) {
      addActivity(st, 'error', 'Gemini balance fetch failed: ' + String((e as Error).message))
      return
    }
  }

  // 3. Equity snapshot (status polls serve this from cache - never sign
  //    a balances call on every 12s app poll).
  st.equitySnap = { at: Date.now(), equity, usdAvailable }

  // 4. UTC day rollover.
  const today = dayKey(new Date())
  if (daily.day !== today) {
    st.setupWindows = {}
    daily.day = today
    daily.startEquity = equity
    daily.tradesPerSymbol = {}
    daily.realizedPnl = 0
    daily.realizedFees = 0
    daily.haltNew = false
    daily.haltReason = ''
    addActivity(st, 'engine', 'New UTC trading day. Counters reset, start equity ' + equity.toFixed(2) + ' USD')
  }

  // 5. Daily P&L + circuit breakers (identical thresholds to the backend).
  let unrealized = 0
  for (const pos of st.positions) {
    const p = priceOf(st, pos.symbol)
    if (p) unrealized += (p - pos.entry) * pos.remainingQty
  }
  const pnlToday = daily.realizedPnl - daily.realizedFees + unrealized
  const pnlPct = daily.startEquity > 0 ? (pnlToday / daily.startEquity) * 100 : 0

  const action = breakerAction(pnlPct, cfg)
  if (action === 'flatten' && !daily.guardLock) {
    daily.guardLock = true
    daily.haltNew = true
    daily.haltReason = 'daily loss limit hit'
    settings.autopilotOn = false
    addActivity(st, 'breaker', 'CIRCUIT BREAKER: day P&L ' + pnlPct.toFixed(2) + '% breached the ' + st.settings.dailyLossLimitPct + '% limit. Flattening everything and stopping the run.')
    await flattenAll(ctx, 'daily circuit breaker')
    return
  }
  if (action === 'halt-new' && !daily.haltNew) {
    daily.haltNew = true
    daily.haltReason = 'daily loss warning hit'
    addActivity(st, 'breaker', 'Daily loss warning: day P&L ' + pnlPct.toFixed(2) + '% - no NEW entries today. Open positions keep being managed.')
  }

  if (!settings.autopilotOn) return
  if (daily.guardLock) return

  // 6. 30d correlations, refreshed hourly.
  await refreshCorrelations(st)

  // 7. Third-coin eligibility gate (auto-validated like the standalone engine).
  const majors = CONFIG.symbols.slice(0, 2)
  const extra = CONFIG.symbols.slice(2)
  const activeSymbols: string[] = [...majors]
  const excluded: string[] = []
  for (const sym of extra) {
    let ok = true
    for (const m of majors) {
      const c = st.corr[sym + '|' + m] ?? st.corr[m + '|' + sym]
      if (Number.isFinite(c) && c >= CONFIG.correlationCap) ok = false
    }
    if (ok) activeSymbols.push(sym)
    else excluded.push(sym)
  }
  const thirdCoinExcluded = excluded.length > 0
  if (thirdCoinExcluded) {
    addActivity(st, 'skip', 'Correlation gate excludes ' + excluded.join(', ') + ' (30d corr to BTC/ETH >= ' + CONFIG.correlationCap + ') - trading majors only with tighter sizing')
  }

  let thirdCoinLog = false
  for (const symbol of activeSymbols) {
    try {
      await scanSymbol(ctx, symbol, mode, equity, usdAvailable, thirdCoinExcluded, thirdCoinLog)
      thirdCoinLog = true
    } catch (e) {
      addActivity(st, 'error', 'scanSymbol ' + symbol + ' failed: ' + String((e as Error).message), symbol)
    }
  }
}

async function refreshCorrelations(st: ServerlessState): Promise<void> {
  if (Date.now() - st.corrAt < 3600_000) return
  st.corrAt = Date.now()
  const syms = CONFIG.symbols
  if (syms.length < 2) return
  try {
    const daily = new Map<string, Awaited<ReturnType<typeof candles>>>()
    for (const s of syms) daily.set(s, await candles(s, '1day'))
    for (let i = 0; i < syms.length; i++) {
      for (let j = i + 1; j < syms.length; j++) {
        st.corr[syms[i] + '|' + syms[j]] = correlationOf(daily.get(syms[i]) ?? [], daily.get(syms[j]) ?? [])
      }
    }
  } catch {
    // next tick retries
  }
}

async function scanSymbol(
  ctx: TickContext,
  symbol: string,
  mode: 'paper' | 'live',
  equity: number,
  usdAvailable: number,
  thirdCoinExcluded: boolean,
  thirdLogEmitted: boolean
): Promise<void> {
  const st = ctx.st
  const cfg = effCfg(st)
  const settings = st.settings
  const daily = st.daily
  const now = Date.now()

  if (st.positions.some((p) => p.symbol === symbol)) return
  if (st.positions.length >= CONFIG.maxConcurrent) return
  const tradesToday = daily.tradesPerSymbol[symbol] ?? 0
  if (tradesToday >= settings.maxTradesPerSymbolPerDay) return

  const windows = st.setupWindows[symbol] ?? []
  if (windows.filter((b) => b === bucket4h(now)).length >= CONFIG.setupsPer4h) return

  const lastTradeAt = st.lastTradeAt[symbol] ?? 0
  if (lastTradeAt > 0 && now - lastTradeAt < CONFIG.cooldownMinutes * 60_000) return

  const tick = st.prices[symbol]
  if (!tick || now - tick.at > CONFIG.staleMs) return // stale-price kill switch

  const c1m = await candles(symbol, '1m')
  const c5m = await candles(symbol, '5m')
  const decision = evaluateSetup(c1m, c5m, now, {
    atrMult: CONFIG.atrMult,
    minStopPct: CONFIG.minStopPct,
    volumeMult: CONFIG.volumeMult
  })
  st.trendLong[symbol] = decision.trendOK // time exits consult this

  if (!decision.enter || decision.kind === null) return

  // --- setup fires: market-quality + risk gates, all of them hard ---
  const priceNow = tick.price || c1m[c1m.length - 1]?.c
  if (!priceNow) return
  const ob = await book(symbol)
  const liq = liquidityOK(ob, { maxSpreadBps: CONFIG.maxSpreadBps, minDepthUsd: CONFIG.minDepthUsd })
  if (!liq.ok) return

  const timeOK = timeWindowOK({
    nowMs: now,
    lowVolumeVolumeOK: decision.volumeRatio >= CONFIG.volumeMult,
    quietMinutes: CONFIG.quietFirstMinutes,
    lowVolumeHours: CONFIG.lowVolumeHours
  })
  if (!timeOK.ok) return

  const corrGate = correlationGateForEntry(symbol, st.positions.map((p) => p.symbol), st.corr, cfg)
  if (!corrGate.ok) return

  const det = await details(symbol)
  const stop = priceNow - decision.stopDist
  let committedUsd = 0
  for (const p of st.positions) {
    const pPrice = priceOf(st, p.symbol)
    if (pPrice) committedUsd += p.remainingQty * pPrice
  }
  const sizing = positionSize({
    equity,
    usdAvailable,
    committedUsd,
    price: priceNow,
    stop,
    step: det.tickSize,
    minNotionalUsd: det.minOrderSizeQuote,
    cfg: CONFIG,
    riskPctOverride: thirdCoinExcluded ? settings.riskPct * 0.75 : settings.riskPct
  })
  if (!sizing.ok) return

  const rr = clampRiskReward(settings.riskReward, CONFIG)
  const rrCheck = rrAfterFees({ price: priceNow, stop, qty: sizing.qty, riskReward: rr, cfg: CONFIG })
  if (!rrCheck.ok) {
    addActivity(st, 'skip', 'Skipped ' + symbol + ': ' + (rrCheck.reason ?? 'risk:reward below minimum after fees'), symbol)
    return
  }

  // --- all gates passed: EXECUTE ---
  const ask = ob.asks.length > 0 ? ob.asks[0].price : priceNow
  let executedQty = 0
  let avgEntry = 0
  let entryFees = 0
  if (mode === 'paper') {
    const res = paperEntry(st, symbol, sizing.qty, priceNow, det.tickSize)
    if (!res.ok) {
      addActivity(st, 'skip', 'Skipped ' + symbol + ': ' + (res.reason ?? 'entry failed'), symbol)
      return
    }
    executedQty = res.qty
    avgEntry = res.avgPrice
    entryFees = res.entryFeeUsd
  } else if (ctx.creds) {
    const res = await liveEntry(ctx.creds, symbol, sizing.qty, ask, det.tickSize, det.quoteIncrement)
    if (!res.ok) {
      addActivity(st, 'skip', 'Skipped ' + symbol + ': ' + (res.reason ?? 'entry failed'), symbol)
      return
    }
    executedQty = res.qty
    avgEntry = res.avgPrice
    entryFees = res.entryFeeUsd
  }
  if (executedQty < det.tickSize) return

  const pos: PositionDoc = {
    id: nextId(st, 'pos'),
    symbol,
    mode,
    qty: executedQty,
    remainingQty: executedQty,
    entry: avgEntry,
    stop: avgEntry - decision.stopDist,
    target: rrCheck.target,
    stopDist: decision.stopDist,
    atr: decision.atr,
    riskUsd: executedQty * decision.stopDist,
    trendAtEntry: decision.trendState,
    openedAt: Date.now(),
    kind: decision.kind,
    stopOrderId: null,
    targetOrderId: null,
    breakevenDone: false,
    trailArmed: false,
    partialDone: false
  }
  st.positions.push(pos)
  addTrade(st, {
    id: pos.id,
    symbol,
    mode,
    status: 'open',
    qty: executedQty,
    entry: avgEntry,
    exit: null,
    exitReason: null,
    feesUsd: entryFees,
    pnlUsd: 0,
    openedAt: pos.openedAt,
    closedAt: null,
    planStop: pos.stop,
    planTarget: rrCheck.target,
    riskUsd: pos.riskUsd,
    kind: pos.kind,
    realizedQty: 0,
    exits: []
  })
  daily.tradesPerSymbol[symbol] = tradesToday + 1
  st.lastTradeAt[symbol] = Date.now()
  st.setupWindows[symbol] = [...windows, bucket4h(now)].slice(-6)
  addActivity(st, 'enter',
    'ENTER ' + symbol + ': bought ' + executedQty.toPrecision(6) + ' @ ' + avgEntry.toFixed(2) +
    ' (' + pos.kind + ') | stop ' + pos.stop.toFixed(2) + ' | target ' + pos.target.toFixed(2) +
    ' | risk ' + pos.riskUsd.toFixed(2) + ' USD | net RR ' + rrCheck.rrNet.toFixed(2) +
    ' | ATR rank ' + (decision.atrRank * 100).toFixed(0) + '% | vol ' + decision.volumeRatio.toFixed(1) + 'x', symbol)

  await ensureProtectiveOrders(ctx, pos)
}

export async function flattenAll(ctx: TickContext, reason: string): Promise<void> {
  const st = ctx.st
  const positions = st.positions.slice()
  for (const pos of positions) {
    await import('./manager.ts').then((m) => m.exitAtMarket(ctx, pos, reason))
  }
}
