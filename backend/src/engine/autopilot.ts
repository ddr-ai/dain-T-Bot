// The Autopilot engine: runs the scan loop (setup detection -> entry) and
// manages open positions through the TradeManager. Everything below is
// fully automatic once the user flips Autopilot ON; the user only receives
// notifications. All hard risk guards from src/risk/guards.ts are enforced
// before any order is placed.

import { Mutex } from '../util/lock.ts'
import { log } from '../util/logger.ts'
import { bucket4h } from '../util/time.ts'
import { dayKey } from '../util/time.ts'
import { GeminiPublic } from '../gemini/public.ts'
import { GeminiRest } from '../gemini/rest.ts'
import { MarketSocket } from '../gemini/ws.ts'
import { CredentialsStore } from '../secure/credentials.ts'
import { Store } from '../store/store.ts'
import type { PositionDoc } from '../store/store.ts'
import { EventBus } from '../notify/events.ts'
import type { AppConfig } from '../config/env.ts'
import { evaluateSetup, trendBiasEma, closedOnly } from '../strategy/signals.ts'
import { liquidityOK, timeWindowOK, correlationOK, correlationOf } from '../strategy/regime.ts'
import { breakerAction, positionSize, rrAfterFees, clampRiskReward, correlationGateForEntry } from '../risk/guards.ts'
import { PaperBroker } from './paperBroker.ts'
import { LiveBroker } from './liveBroker.ts'
import { TradeManager } from './tradeManager.ts'
import { chunkQty } from './broker.ts'
import type { Broker } from './broker.ts'
import type { Candle } from '../gemini/types.ts'
import { sleepMs } from './util.ts'

export interface SymbolTick {
  price: number
  at: number
}

export interface UpdateSettingsResult {
  ok: boolean
  error?: string
}

export class Autopilot {
  private sockets = new Map<string, MarketSocket>()
  private prices = new Map<string, SymbolTick>()
  private candles1m = new Map<string, { at: number, data: Candle[] }>()
  private candles5m = new Map<string, { at: number, data: Candle[] }>()
  private corr = new Map<string, number>()
  private corrAt = 0
  private trendLong = new Map<string, boolean>()
  private lastSkip = new Map<string, string>()
  private scanTimer: NodeJS.Timeout | undefined
  private manageTimer: NodeJS.Timeout | undefined
  private busy = new Mutex()
  private lastScanAt = 0
  private autopilotLoggedOff = false
  private thirdCoinExcluded = false

  readonly paperBroker: PaperBroker
  private liveBrokerInternal: LiveBroker | undefined
  readonly tradeManager: TradeManager

  constructor(
    private cfg: AppConfig,
    private pub: GeminiPublic,
    readonly rest: GeminiRest,
    private store: Store,
    private events: EventBus,
    private creds: CredentialsStore
  ) {
    this.paperBroker = new PaperBroker(store, cfg, (sym) => this.priceOf(sym))
    this.tradeManager = new TradeManager({
      cfg,
      store,
      events,
      brokerFor: (mode) => this.brokerFor(mode),
      priceOf: (sym) => this.priceOf(sym),
      trendLongOf: (sym) => this.trendLong.get(sym) ?? null,
      detailsOf: (symbol) => pub.details(symbol)
    })
  }

  brokerFor(mode: 'paper' | 'live'): Broker | undefined {
    if (mode === 'paper') return this.paperBroker
    if (!this.cfg) return undefined
    if (!this.rest.hasCreds()) return undefined
    if (!this.liveBrokerInternal) {
      this.liveBrokerInternal = new LiveBroker(this.rest, this.pub, this.cfg, (s) => this.pub.details(s))
    }
    return this.liveBrokerInternal
  }

  priceOf(symbol: string): number | undefined {
    const t = this.prices.get(symbol)
    return t ? t.price : undefined
  }

  private freshTick(symbol: string): boolean {
    const t = this.prices.get(symbol)
    return t !== undefined && Date.now() - t.at <= this.cfg.staleMs
  }

  async start(): Promise<void> {
    if (this.scanTimer) return
    let host = 'api.gemini.com'
    try {
      host = new URL(this.cfg.publicBaseUrl).host
    } catch { /* keep default */ }
    for (const symbol of this.cfg.symbols) {
      const sock = new MarketSocket({
        host,
        symbol,
        onPrice: (price) => {
          this.prices.set(symbol, { price, at: Date.now() })
          this.events.emit('price', { symbol, price, ts: Date.now() })
        }
      })
      sock.start()
      this.sockets.set(symbol, sock)
    }
    this.scanTimer = setInterval(() => void this.safeScan(), this.cfg.scanIntervalSec * 1000)
    this.manageTimer = setInterval(() => void this.safeManage(), this.cfg.manageIntervalSec * 1000)
    this.store.addActivity('engine', 'Engine started. Autopilot is ' + (this.store.state.settings.autopilotOn ? 'ON' : 'OFF') + ', mode: ' + (this.store.state.settings.paper ? 'paper' : 'live'))
    // initial scan shortly after boot
    setTimeout(() => void this.safeScan(), 3000)
  }

  async stop(): Promise<void> {
    if (this.scanTimer) clearInterval(this.scanTimer)
    if (this.manageTimer) clearInterval(this.manageTimer)
    this.scanTimer = undefined
    this.manageTimer = undefined
    for (const s of this.sockets.values()) s.stop()
    this.sockets.clear()
    this.store.saveNow()
  }

  private async safeScan(): Promise<void> {
    try {
      await this.busy.run(() => this.scanOnce())
    } catch (e) {
      log.error('scan failed: ' + String((e as Error).message))
      this.store.addActivity('error', 'Scan error: ' + String((e as Error).message))
    }
  }

  private async safeManage(): Promise<void> {
    try {
      await this.busy.run(() => this.tradeManager.manageAll())
    } catch (e) {
      log.error('manage failed: ' + String((e as Error).message))
    }
  }

  // REST price refresh: green light for the stale-price kill switch.
  private async refreshTickers(): Promise<void> {
    await Promise.allSettled(
      this.cfg.symbols.map(async (symbol) => {
        try {
          const t = await this.pub.ticker(symbol)
          if (Number.isFinite(t.last) && t.last > 0) {
            this.prices.set(symbol, { price: t.last, at: Date.now() })
            this.events.emit('price', { symbol, price: t.last, ts: Date.now() })
          }
        } catch (e) {
          log.warn('ticker refresh failed for ' + symbol + ': ' + String((e as Error).message))
        }
      })
    )
  }

  private async getCandles(symbol: string, frame: '1m' | '5m'): Promise<Candle[]> {
    const map = frame === '1m' ? this.candles1m : this.candles5m
    const hit = map.get(symbol)
    if (hit && Date.now() - hit.at < 25_000) return hit.data
    const data = await this.pub.candles(symbol, frame)
    map.set(symbol, { at: Date.now(), data })
    return data
  }

  private async refreshCorrelations(): Promise<void> {
    if (Date.now() - this.corrAt < 3600_000) return
    this.corrAt = Date.now()
    const syms = this.cfg.symbols
    if (syms.length < 2) return
    try {
      const daily = new Map<string, Candle[]>()
      for (const s of syms) daily.set(s, await this.pub.candles(s, '1day'))
      for (let i = 0; i < syms.length; i++) {
        for (let j = i + 1; j < syms.length; j++) {
          const c = correlationOf(daily.get(syms[i]) ?? [], daily.get(syms[j]) ?? [])
          this.corr.set(syms[i] + '|' + syms[j], c)
          log.info('30d correlation ' + syms[i] + '/' + syms[j] + ': ' + c.toFixed(2))
        }
      }
    } catch (e) {
      log.warn('correlation refresh failed: ' + String((e as Error).message))
    }
  }

  private corrRecord(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [k, v] of this.corr) out[k] = v
    return out
  }

  private skipOnce(symbol: string, reason: string): void {
    const prev = this.lastSkip.get(symbol)
    if (prev === reason) return
    this.lastSkip.set(symbol, reason)
    if (reason.startsWith('no setup') || reason.startsWith('trend filter')) return // too chatty
    this.store.addActivity('skip', 'Skipped ' + symbol + ': ' + reason, symbol)
  }

  private async scanOnce(): Promise<void> {
    this.lastScanAt = Date.now()
    const st = this.store.state
    const settings = st.settings
    const daily = st.daily
    await this.refreshTickers()

    const mode: 'paper' | 'live' = settings.paper ? 'paper' : 'live'
    const broker = this.brokerFor(mode)
    if (!broker) {
      this.skipOnce(mode, 'live mode requires Gemini credentials (set them in Settings/Connect)')
      return
    }

    const priceMap: Record<string, number> = {}
    for (const [k, v] of this.prices) priceMap[k] = v.price
    const equity = await broker.equity(priceMap)
    const usdAvailable = await broker.usdAvailable()

    // UTC day rollover resets counters and re-anchors starting equity.
    const today = dayKey(new Date())
    if (daily.day !== today) {
      st.setupWindows = {}
      this.lastSkip.clear()
      daily.day = today
      daily.startEquity = equity
      daily.tradesPerSymbol = {}
      daily.realizedPnl = 0
      daily.realizedFees = 0
      daily.haltNew = false
      daily.haltReason = ''
      this.store.addActivity('engine', 'New UTC trading day. Counters reset, start equity ' + equity.toFixed(2) + ' USD')
      this.store.saveSoon()
    }

    // Daily P&L: realized minus fees, plus open-position unrealized.
    let unrealized = 0
    for (const pos of st.positions) {
      const p = this.priceOf(pos.symbol)
      if (p) unrealized += (p - pos.entry) * pos.remainingQty
    }
    const pnlToday = daily.realizedPnl - daily.realizedFees + unrealized
    const pnlPct = daily.startEquity > 0 ? (pnlToday / daily.startEquity) * 100 : 0

    // Circuit breakers.
    const action = breakerAction(pnlPct, this.cfg)
    if (action === 'flatten' && !daily.guardLock) {
      daily.guardLock = true
      daily.haltNew = true
      daily.haltReason = 'daily loss limit hit'
      settings.autopilotOn = false
      this.store.addActivity('breaker', 'CIRCUIT BREAKER: day P&L ' + pnlPct.toFixed(2) + '% breached the ' + this.cfg.dailyLossLimitPct + '% limit. Flattening everything and disabling autopilot.')
      this.events.emit('status', { kind: 'breaker', msg: 'Daily loss limit hit: flattened and paused' })
      await this.flattenAllInternal('daily circuit breaker')
      this.store.saveNow()
      return
    }
    if (action === 'halt-new' && !daily.haltNew) {
      daily.haltNew = true
      daily.haltReason = 'daily loss warning hit'
      this.store.addActivity('breaker', 'Daily loss warning: day P&L ' + pnlPct.toFixed(2) + '% - no NEW entries today. Open positions keep being managed.')
      this.events.emit('status', { kind: 'breaker', msg: 'Daily loss warning: new entries halted for today' })
      this.store.saveSoon()
    }

    if (!settings.autopilotOn) {
      if (!this.autopilotLoggedOff) {
        this.store.addActivity('engine', 'Autopilot is OFF. Scanning paused; positions are still managed if any are open.')
        this.autopilotLoggedOff = true
      }
      return
    }
    this.autopilotLoggedOff = false
    if (daily.guardLock) {
      this.skipOnce('autopilot', 'circuit breaker tripped - re-enable Autopilot to reset (manual reset)')
      return
    }

    await this.refreshCorrelations()

    // Third-coin eligibility (auto-validated): a symbol beyond the majors
    // (BTC, ETH) is only traded if its 30d correlation to BOTH majors stays
    // below the cap. Otherwise we trade the majors only, with tighter sizing.
    const majors = this.cfg.symbols.slice(0, 2)
    const extra = this.cfg.symbols.slice(2)
    const activeSymbols: string[] = [...majors]
    const excluded: string[] = []
    for (const s of extra) {
      let ok = true
      for (const m of majors) {
        const c = this.corr.get(s + '|' + m) ?? this.corr.get(m + '|' + s)
        if (Number.isFinite(c) && c >= this.cfg.correlationCap) ok = false
      }
      if (ok) activeSymbols.push(s)
      else excluded.push(s)
    }
    this.thirdCoinExcluded = excluded.length > 0
    if (this.thirdCoinExcluded) {
      this.skipOnce('third-coin', 'correlation gate excludes ' + excluded.join(', ') + ' (30d correlation to BTC/ETH >= ' + this.cfg.correlationCap + ') - trading majors only with tighter sizing')
    }

    for (const symbol of activeSymbols) {
      try {
        await this.scanSymbol(symbol, mode, broker, equity, usdAvailable)
      } catch (e) {
        log.error('scanSymbol ' + symbol + ' failed: ' + String((e as Error).message))
      }
    }
  }

  private async scanSymbol(
    symbol: string,
    mode: 'paper' | 'live',
    broker: Broker,
    equity: number,
    usdAvailable: number
  ): Promise<void> {
    const st = this.store.state
    const settings = st.settings
    const daily = st.daily
    const now = Date.now()

    if (st.positions.some((p) => p.symbol === symbol)) return
    if (st.positions.length >= this.cfg.maxConcurrent) {
      this.skipOnce(symbol, 'max concurrent positions (' + this.cfg.maxConcurrent + ')')
      return
    }

    const tradesToday = daily.tradesPerSymbol[symbol] ?? 0
    if (tradesToday >= settings.maxTradesPerSymbolPerDay) {
      this.skipOnce(symbol, 'max trades per day reached (' + settings.maxTradesPerSymbolPerDay + ')')
      return
    }

    const windows = st.setupWindows[symbol] ?? []
    const currentBucket = bucket4h(now)
    const inWindow = windows.filter((b) => b === currentBucket).length
    if (inWindow >= this.cfg.setupsPer4h) {
      this.skipOnce(symbol, 'setup taken this 4h window')
      return
    }

    const lastTradeAt = st.lastTradeAt[symbol] ?? 0
    if (lastTradeAt > 0 && now - lastTradeAt < this.cfg.cooldownMinutes * 60_000) {
      this.skipOnce(symbol, 'cooldown (' + this.cfg.cooldownMinutes + ' min between trades)')
      return
    }

    if (!this.freshTick(symbol)) {
      this.skipOnce(symbol, 'stale price feed - kill switch active')
      return
    }

    const c1m = await this.getCandles(symbol, '1m')
    const c5m = await this.getCandles(symbol, '5m')
    const decision = evaluateSetup(c1m, c5m, now, {
      atrMult: this.cfg.atrMult,
      minStopPct: this.cfg.minStopPct,
      volumeMult: this.cfg.volumeMult
    })
    // keep trend cache fresh for time-based exits
    this.trendLong.set(symbol, decision.trendOK)

    if (!decision.enter || decision.kind === null) {
      this.skipOnce(symbol, decision.reasons.length > 0 ? decision.reasons[decision.reasons.length - 1] : 'no setup')
      return
    }

    // --- signal found: run the market-quality and risk gates ---
    const tick = this.prices.get(symbol)
    const priceNow = tick ? tick.price : (c1m[c1m.length - 1]?.c ?? 0)
    const book = await this.pub.book(symbol)
    const liq = liquidityOK(book, this.cfg)
    if (!liq.ok) {
      this.skipOnce(symbol, 'book too thin: spread ' + liq.spreadBps.toFixed(1) + 'bps, depth $' + liq.depthUsd.toFixed(0))
      return
    }

    const timeOK = timeWindowOK({
      nowMs: now,
      lowVolumeVolumeOK: decision.volumeRatio >= this.cfg.volumeMult,
      quietMinutes: this.cfg.quietFirstMinutes,
      lowVolumeHours: this.cfg.lowVolumeHours
    })
    if (!timeOK.ok) {
      this.skipOnce(symbol, timeOK.reason)
      return
    }

    const corrRecord = this.corrRecord()
    const corrGate = correlationGateForEntry(symbol, st.positions.map((p) => p.symbol), corrRecord, this.cfg)
    if (!corrGate.ok) {
      this.skipOnce(symbol, corrGate.reason ?? 'correlation gate')
      return
    }

    const det = await this.pub.details(symbol)
    const stop = priceNow - decision.stopDist
    let committedUsd = 0
    for (const p of st.positions) {
      const pPrice = this.priceOf(p.symbol)
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
      cfg: this.cfg,
      // tighter sizing when the third coin was excluded (spec Section 4G)
      riskPctOverride: this.thirdCoinExcluded ? settings.riskPct * 0.75 : settings.riskPct
    })
    if (!sizing.ok) {
      this.skipOnce(symbol, 'risk guard: ' + (sizing.reason ?? 'rejected'))
      return
    }

    const rr = clampRiskReward(settings.riskReward, this.cfg)
    const rrCheck = rrAfterFees({ price: priceNow, stop, qty: sizing.qty, riskReward: rr, cfg: this.cfg })
    if (!rrCheck.ok) {
      this.skipOnce(symbol, rrCheck.reason ?? 'risk:reward below minimum after fees')
      return
    }

    // --- gates passed: EXECUTE autonomously ---
    const bestBid = book.bids.length > 0 ? book.bids[0].price : priceNow
    const chunks = chunkQty(sizing.qty, priceNow, this.cfg.orderChunkThresholdUsd, det.tickSize)
    let executedQty = 0
    let cost = 0
    let entryFees = 0
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleepMs(30_000) // chunk spacing per spec
      if (!st.settings.autopilotOn) {
        this.store.addActivity('engine', 'Autopilot turned OFF mid-entry, stopping remaining chunks')
        break
      }
      const res = await broker.placeEntry(symbol, chunks[i], bestBid, det.tickSize, det.quoteIncrement)
      if (res.ok) {
        executedQty += res.qty
        cost += res.qty * res.avgPrice
        entryFees += res.entryFeeUsd
      } else if (i === 0) {
        this.skipOnce(symbol, 'entry failed: ' + (res.reason ?? 'unknown'))
        return
      }
    }
    if (executedQty < det.tickSize) {
      this.skipOnce(symbol, 'entry not filled (post-only unfilled)')
      return
    }
    const avgEntry = cost / executedQty
    const actualStopDist = decision.stopDist
    const pos: PositionDoc = {
      id: this.store.nextId('pos'),
      symbol,
      mode,
      qty: executedQty,
      remainingQty: executedQty,
      entry: avgEntry,
      stop: avgEntry - actualStopDist,
      target: rrCheck.target,
      stopDist: actualStopDist,
      atr: decision.atr,
      riskUsd: executedQty * actualStopDist,
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
    this.store.addTrade({
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
    st.setupWindows[symbol] = [...windows, currentBucket].slice(-6)
    const msg = 'ENTER ' + symbol + ': bought ' + executedQty.toPrecision(6) + ' @ ' + avgEntry.toFixed(2) +
      ' (' + pos.kind + ') | stop ' + pos.stop.toFixed(2) + ' | target ' + pos.target.toFixed(2) +
      ' | risk ' + pos.riskUsd.toFixed(2) + ' USD | net RR ' + rrCheck.rrNet.toFixed(2) +
      ' | ATR rank ' + (decision.atrRank * 100).toFixed(0) + '% | vol ' + decision.volumeRatio.toFixed(1) + 'x'
    this.store.addActivity('enter', msg, symbol)
    this.events.emit('trade', { kind: 'entry', symbol, entry: avgEntry, stop: pos.stop, target: pos.target, qty: executedQty, reason: pos.kind })
    this.store.saveNow()

    await this.tradeManager.ensureProtectiveOrders(pos)
  }

  // One-tap emergency stop: cancel orders, flatten, halt autopilot.
  async emergencyStop(reason: string): Promise<void> {
    await this.busy.run(async () => {
      this.store.state.settings.autopilotOn = false
      this.store.addActivity('emergency', 'EMERGENCY STOP: ' + reason + '. Cancelling orders and flattening.')
      await this.flattenAllInternal(reason)
      this.store.saveNow()
      this.events.emit('status', { kind: 'emergency-stop', msg: reason })
    })
  }

  private async flattenAllInternal(reason: string): Promise<void> {
    const st = this.store.state
    const positions = st.positions.slice()
    for (const pos of positions) {
      await this.tradeManager.exitAtMarket(pos, 'emergency stop: ' + reason)
    }
    // cancel any stray orders on every symbol in both brokers
    for (const symbol of this.cfg.symbols) {
      await this.paperBroker.cancelAllFor(symbol).catch(() => undefined)
      const live = this.brokerFor('live')
      if (live) await live.cancelAllFor(symbol).catch(() => undefined)
    }
  }

  setAutopilot(on: boolean): void {
    const st = this.store.state
    st.settings.autopilotOn = on
    if (on) {
      // Manual reset after a circuit breaker: user explicitly re-enabled.
      st.daily.guardLock = false
      this.store.addActivity('engine', 'Autopilot turned ON (manual reset)')
    } else {
      this.store.addActivity('engine', 'Autopilot turned OFF')
    }
    this.store.saveNow()
    this.events.emit('status', { kind: 'autopilot', on })
    this.events.emit('settings', this.strippedCredsSettings())
  }

  updateSettings(patch: Record<string, unknown>): UpdateSettingsResult {
    const st = this.store.state
    const s = st.settings
    const bad = (error: string) => ({ ok: false, error })
    if (patch.riskReward !== undefined) {
      const v = Number(patch.riskReward)
      if (!Number.isFinite(v)) return bad('riskReward must be a number')
      s.riskReward = clampRiskReward(v, this.cfg)
    }
    if (patch.riskPct !== undefined) {
      const v = Number(patch.riskPct)
      if (!Number.isFinite(v) || v <= 0 || v > this.cfg.maxRiskPct) return bad('riskPct must be in (0, ' + this.cfg.maxRiskPct + ']')
      s.riskPct = v
    }
    if (patch.maxTradesPerSymbolPerDay !== undefined) {
      const v = Number(patch.maxTradesPerSymbolPerDay)
      if (!Number.isInteger(v) || v < 1 || v > this.cfg.maxTradesPerSymbolPerDay) return bad('maxTradesPerSymbolPerDay must be an integer in [1, ' + this.cfg.maxTradesPerSymbolPerDay + ']')
      s.maxTradesPerSymbolPerDay = v
    }
    if (patch.dailyLossWarnPct !== undefined) {
      const v = Number(patch.dailyLossWarnPct)
      if (!Number.isFinite(v) || v <= 0 || v > 10) return bad('dailyLossWarnPct must be in (0, 10]')
      s.dailyLossWarnPct = v
    }
    if (patch.dailyLossLimitPct !== undefined) {
      const v = Number(patch.dailyLossLimitPct)
      if (!Number.isFinite(v) || v <= s.dailyLossWarnPct || v > 15) return bad('dailyLossLimitPct must be > warn and <= 15')
      s.dailyLossLimitPct = v
    }
    for (const flag of ['notifyFills', 'notifyStops', 'notifyBreaker'] as const) {
      if (patch[flag] !== undefined) {
        if (typeof patch[flag] !== 'boolean') return bad(flag + ' must be boolean')
        s[flag] = patch[flag] as boolean
      }
    }
    if (patch.paper !== undefined) {
      if (typeof patch.paper !== 'boolean') return bad('paper must be boolean')
      if (patch.paper !== s.paper) {
        if (st.positions.length > 0) return bad('switch paper/live mode only with NO open positions (run emergency stop first)')
        s.paper = patch.paper
        this.store.addActivity('engine', 'Mode switched to ' + (s.paper ? 'PAPER' : 'LIVE') + ' trading')
      }
    }
    this.store.saveNow()
    this.events.emit('settings', this.strippedCredsSettings())
    return { ok: true }
  }

  private strippedCredsSettings(): Record<string, unknown> {
    const s = this.store.state.settings
    return {
      autopilotOn: s.autopilotOn,
      riskReward: s.riskReward,
      riskPct: s.riskPct,
      paper: s.paper,
      maxTradesPerSymbolPerDay: s.maxTradesPerSymbolPerDay,
      dailyLossWarnPct: s.dailyLossWarnPct,
      dailyLossLimitPct: s.dailyLossLimitPct,
      notifyFills: s.notifyFills,
      notifyStops: s.notifyStops,
      notifyBreaker: s.notifyBreaker
    }
  }

  async status(): Promise<Record<string, unknown>> {
    const st = this.store.state
    const mode = st.settings.paper ? 'paper' : 'live'
    const broker = this.brokerFor(mode as 'paper' | 'live')
    const priceMap: Record<string, number> = {}
    for (const [k, v] of this.prices) priceMap[k] = v.price
    let equity = 0
    let usdAvailable = 0
    try {
      if (broker) {
        equity = await broker.equity(priceMap)
        usdAvailable = await broker.usdAvailable()
      }
    } catch { /* offline view */ }
    let unrealized = 0
    const positions = st.positions.map((p) => {
      const price = this.priceOf(p.symbol)
      const upnl = price ? (price - p.entry) * p.remainingQty : null
      unrealized += upnl ?? 0
      return {
        ...p,
        currentPrice: price ?? null,
        unrealizedPnl: upnl
      }
    })
    const pnlToday = st.daily.realizedPnl - st.daily.realizedFees + unrealized
    const prices: Record<string, SymbolTick> = {}
    for (const [k, v] of this.prices) prices[k] = v
    return {
      running: this.scanTimer !== undefined,
      autopilotOn: st.settings.autopilotOn,
      mode,
      hasCredentials: this.rest.hasCreds() || this.creds.load() !== undefined,
      equity,
      usdAvailable,
      pnlToday,
      pnlTodayPct: st.daily.startEquity > 0 ? (pnlToday / st.daily.startEquity) * 100 : 0,
      dayStartEquity: st.daily.startEquity,
      haltNew: st.daily.haltNew,
      haltReason: st.daily.haltReason,
      guardLock: st.daily.guardLock,
      lastScanAt: this.lastScanAt,
      stalePrices: this.cfg.symbols.filter((s) => !this.freshTick(s)),
      positions,
      prices
    }
  }

  correlationsSnapshot(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [k, v] of this.corr) out[k] = v
    return out
  }

  trendLongOf(symbol: string): boolean | null {
    return this.trendLong.get(symbol) ?? null
  }

  // Used by tests/tools: current closed-candle trend bias.
  async trendFresh(symbol: string): Promise<boolean | null> {
    try {
      const c5m = await this.getCandles(symbol, '5m')
      return trendBiasEma(closedOnly(c5m, 300_000, Date.now())).long
    } catch {
      return null
    }
  }

  correlationOK(corr: number): boolean {
    return correlationOK(corr, this.cfg.correlationCap)
  }
}
