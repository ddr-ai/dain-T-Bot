// De-bounced JSON state store with atomic writes. Holds the entire bot
// brain: settings, open positions, trade history, daily counters and the
// activity log. Restart-safe.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from '../config/env.ts'
import type { EventBus } from '../notify/events.ts'

type Dict<T> = Record<string, T>

export interface SettingsDoc {
  autopilotOn: boolean
  riskReward: number          // 0.5 .. 3.0, take-profit multiple only
  riskPct: number             // percent of equity per trade (capped by config)
  paper: boolean
  maxTradesPerSymbolPerDay: number
  dailyLossWarnPct: number
  dailyLossLimitPct: number
  notifyFills: boolean
  notifyStops: boolean
  notifyBreaker: boolean
}

export interface PositionDoc {
  id: string
  symbol: string
  mode: 'paper' | 'live'
  qty: number
  remainingQty: number
  entry: number
  stop: number
  target: number
  stopDist: number
  atr: number
  riskUsd: number
  trendAtEntry: number
  openedAt: number
  kind: string
  stopOrderId: string | null
  targetOrderId: string | null
  breakevenDone: boolean
  trailArmed: boolean
  partialDone: boolean
}

export interface ExitDoc {
  qty: number
  price: number
  feeUsd: number
  reason: string
  ts: number
}

export interface TradeDoc {
  id: string
  symbol: string
  mode: string
  status: 'open' | 'closed'
  qty: number
  entry: number
  exit: number | null          // volume-weighted when multiple exits
  exitReason: string | null
  feesUsd: number               // entry + exit fees
  pnlUsd: number                // realized on closed exits
  openedAt: number
  closedAt: number | null
  planStop: number
  planTarget: number
  riskUsd: number
  kind: string
  realizedQty: number
  exits: ExitDoc[]
}

export interface ActivityDoc {
  ts: number
  kind: string
  msg: string
  symbol?: string
}

export interface DailyDoc {
  day: string
  startEquity: number
  realizedPnl: number
  realizedFees: number
  tradesPerSymbol: Dict<number>
  haltNew: boolean
  haltReason: string
  guardLock: boolean   // circuit breaker tripped: needs explicit user re-enable
}

export interface StateDoc {
  version: 1
  seq: number
  settings: SettingsDoc
  daily: DailyDoc
  positions: PositionDoc[]
  trades: TradeDoc[]
  activity: ActivityDoc[]
  lastTradeAt: Dict<number>
  setupWindows: Dict<string[]>   // symbol -> rolling 4h bucket keys
  paperBalances: { usd: number, coins: Dict<number> }
}

export type PriceMap = Record<string, number>

export interface BrokerOrderRef {
  orderId: string
  price: number
}

export interface EntryResult {
  ok: boolean
  reason?: string
  qty: number
  avgPrice: number
  entryFeeUsd: number
}

export interface SellResult {
  ok: boolean
  qty: number
  avgPrice: number
  feeUsd: number
}

export interface OrderFill {
  kind: 'stop' | 'target'
  orderId: string
  qty: number
  price: number
  feeUsd: number
}

const ACTIVITY_CAP = 800
const TRADES_CAP = 2000

export class Store {
  state: StateDoc
  private saveTimer: NodeJS.Timeout | undefined

  constructor(private dataDir: string, cfg: AppConfig, private events?: EventBus) {
    this.state = this.loadOrSeed(cfg)
  }

  private path(): string {
    return join(this.dataDir, 'state.json')
  }

  private loadOrSeed(cfg: AppConfig): StateDoc {
    mkdirSync(this.dataDir, { recursive: true })
    const p = this.path()
    if (existsSync(p)) {
      try {
        const doc = JSON.parse(readFileSync(p, 'utf8')) as StateDoc
        if (doc && doc.version === 1 && Array.isArray(doc.positions)) {
          doc.settings = this.mergeSettings(doc.settings, cfg)
          doc.daily = doc.daily ?? this.seedDaily(cfg.paperCash)
          if (!doc.paperBalances) doc.paperBalances = { usd: cfg.paperCash, coins: {} }
          if (!doc.lastTradeAt) doc.lastTradeAt = {}
          if (!doc.setupWindows) doc.setupWindows = {}
          return doc
        }
      } catch {
        // fall through to seed
      }
    }
    return this.seed(cfg)
  }

  private mergeSettings(s: Partial<SettingsDoc> | undefined, cfg: AppConfig): SettingsDoc {
    const base = this.seedSettings(cfg)
    if (!s) return base
    return {
      autopilotOn: typeof s.autopilotOn === 'boolean' ? s.autopilotOn : base.autopilotOn,
      riskReward: Math.min(cfg.rrMax, Math.max(cfg.rrMin, Number(s.riskReward) || base.riskReward)),
      riskPct: Math.min(cfg.maxRiskPct, Math.max(0, Number(s.riskPct) || base.riskPct)),
      paper: typeof s.paper === 'boolean' ? s.paper : base.paper,
      maxTradesPerSymbolPerDay: Math.min(cfg.maxTradesPerSymbolPerDay, Math.max(1, Number(s.maxTradesPerSymbolPerDay) || base.maxTradesPerSymbolPerDay)),
      dailyLossWarnPct: Number(s.dailyLossWarnPct) || base.dailyLossWarnPct,
      dailyLossLimitPct: Number(s.dailyLossLimitPct) || base.dailyLossLimitPct,
      notifyFills: typeof s.notifyFills === 'boolean' ? s.notifyFills : true,
      notifyStops: typeof s.notifyStops === 'boolean' ? s.notifyStops : true,
      notifyBreaker: typeof s.notifyBreaker === 'boolean' ? s.notifyBreaker : true
    }
  }

  private seedSettings(cfg: AppConfig): SettingsDoc {
    return {
      autopilotOn: false,
      riskReward: cfg.defaultRiskReward,
      riskPct: cfg.riskPct,
      paper: cfg.paper,
      maxTradesPerSymbolPerDay: cfg.maxTradesPerSymbolPerDay,
      dailyLossWarnPct: cfg.dailyLossWarnPct,
      dailyLossLimitPct: cfg.dailyLossLimitPct,
      notifyFills: true,
      notifyStops: true,
      notifyBreaker: true
    }
  }

  private seedDaily(startEquity: number): DailyDoc {
    return {
      day: new Date().toISOString().slice(0, 10),
      startEquity,
      realizedPnl: 0,
      realizedFees: 0,
      tradesPerSymbol: {},
      haltNew: false,
      haltReason: '',
      guardLock: false
    }
  }

  private seed(cfg: AppConfig): StateDoc {
    return {
      version: 1,
      seq: 1,
      settings: this.seedSettings(cfg),
      daily: this.seedDaily(cfg.paperCash),
      positions: [],
      trades: [],
      activity: [],
      lastTradeAt: {},
      setupWindows: {},
      paperBalances: { usd: cfg.paperCash, coins: {} }
    }
  }

  nextId(prefix: string): string {
    this.state.seq += 1
    return prefix + '-' + Date.now().toString(36) + '-' + this.state.seq.toString(36)
  }

  // De-bounced persistence; data loss window is at most ~1s.
  saveSoon(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.saveNow()
    }, 1000)
  }

  saveNow(): void {
    try {
      const tmp = this.path() + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.state))
      renameSync(tmp, this.path())
    } catch (e) {
      console.error('[' + new Date().toISOString() + '] [ERROR] state persist failed: ' + String((e as Error).message))
    }
  }

  addActivity(kind: string, msg: string, symbol?: string): ActivityDoc {
    const rec: ActivityDoc = { ts: Date.now(), kind, msg, symbol }
    this.state.activity.push(rec)
    if (this.state.activity.length > ACTIVITY_CAP) this.state.activity.splice(0, this.state.activity.length - ACTIVITY_CAP)
    this.saveSoon()
    if (this.events) this.events.emit('activity', rec)
    return rec
  }

  addTrade(t: TradeDoc): void {
    this.state.trades.unshift(t)
    if (this.state.trades.length > TRADES_CAP) this.state.trades.splice(TRADES_CAP)
    this.saveSoon()
  }

  // UTC daily rollover: reset counters, capture the day's starting equity.
  rollDayIfNeeded(startEquity: number): boolean {
    const today = new Date().toISOString().slice(0, 10)
    if (this.state.daily.day === today) return false
    this.state.daily = this.seedDaily(startEquity)
    this.state.setupWindows = {}
    this.saveSoon()
    return true
  }
}
