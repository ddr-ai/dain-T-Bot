// State document for the serverless engine, persisted in Netlify Blobs.
// Mirrors backend/src/store/store.ts StateDoc 1:1, plus the run-window field
// (startedAt + minutes) that powers the "run for N hours" START/STOP flow.

import { CONFIG, RUN_MINUTES_DEFAULT } from './config.ts'

type Dict<T> = Record<string, T>

export interface SettingsDoc {
  autopilotOn: boolean
  riskReward: number
  riskPct: number
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
  exit: number | null
  exitReason: string | null
  feesUsd: number
  pnlUsd: number
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
  guardLock: boolean
}

export interface RunDoc {
  startedAt: number
  minutes: number
}

export interface ServerlessState {
  version: 2
  seq: number
  settings: SettingsDoc
  daily: DailyDoc
  positions: PositionDoc[]
  trades: TradeDoc[]
  activity: ActivityDoc[]
  lastTradeAt: Dict<number>
  setupWindows: Dict<string[]>
  paperBalances: { usd: number, coins: Dict<number> }
  // serverless-only additions:
  run: RunDoc                       // current/last run window
  prices: Dict<{ price: number, at: number }>   // last seen tick per symbol
  trendLong: Dict<boolean>           // scan-fresh 1h+15m trend bias per symbol
  corr: Dict<number>                 // 30d correlation record 'a|b' -> c
  corrAt: number                     // ms timestamp of last correlation refresh
  lastScanAt: number
  lastTickAt: number
  paperOrders: Dict<Array<{ id: string, kind: 'stop' | 'target', qty: number, price: number }>>
  // equity snapshot from the last tick (status polling never signs balances):
  equitySnap: { at: number, equity: number, usdAvailable: number }
}

const ACTIVITY_CAP = 800
const TRADES_CAP = 2000

export function seedSettings(): SettingsDoc {
  return {
    autopilotOn: false,
    riskReward: CONFIG.defaultRiskReward,
    riskPct: CONFIG.riskPct,
    // LIVE is the default for the hosted deployment (explicit user request).
    // With no Gemini credentials saved the engine falls back to skips-with-
    // a-reason instead of placing real orders, so this is safe to default.
    paper: CONFIG.paper,
    maxTradesPerSymbolPerDay: CONFIG.maxTradesPerSymbolPerDay,
    dailyLossWarnPct: CONFIG.dailyLossWarnPct,
    dailyLossLimitPct: CONFIG.dailyLossLimitPct,
    notifyFills: true,
    notifyStops: true,
    notifyBreaker: true
  }
}

export function seedDaily(startEquity: number): DailyDoc {
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

export function seedState(): ServerlessState {
  return {
    version: 2,
    seq: 1,
    settings: seedSettings(),
    daily: seedDaily(CONFIG.paperCash),
    positions: [],
    trades: [],
    activity: [],
    lastTradeAt: {},
    setupWindows: {},
    paperBalances: { usd: CONFIG.paperCash, coins: {} },
    run: { startedAt: 0, minutes: RUN_MINUTES_DEFAULT },
    prices: {},
    trendLong: {},
    corr: {},
    corrAt: 0,
    lastScanAt: 0,
    lastTickAt: 0,
    paperOrders: {},
    equitySnap: { at: 0, equity: CONFIG.paperCash, usdAvailable: CONFIG.paperCash }
  }
}

export function mergeState(raw: unknown): ServerlessState {
  const base = seedState()
  const s = raw as Partial<ServerlessState>
  if (!s || typeof s !== 'object') return base
  const merged: ServerlessState = {
    ...base,
    ...s,
    settings: { ...base.settings, ...(s.settings ?? {}) },
    daily: { ...base.daily, ...(s.daily ?? {}) },
    run: { ...base.run, ...(s.run ?? {}) },
    paperBalances: { ...base.paperBalances, ...(s.paperBalances ?? {}) },
    positions: Array.isArray(s.positions) ? s.positions : [],
    trades: Array.isArray(s.trades) ? s.trades : [],
    activity: Array.isArray(s.activity) ? s.activity : [],
    lastTradeAt: s.lastTradeAt ?? {},
    setupWindows: s.setupWindows ?? {},
    prices: s.prices ?? {},
    trendLong: s.trendLong ?? {},
    corr: s.corr ?? {},
    paperOrders: s.paperOrders ?? {},
    equitySnap: s.equitySnap ?? base.equitySnap
  }
  return merged
}

export function addActivity(st: ServerlessState, kind: string, msg: string, symbol?: string): void {
  st.activity.push({ ts: Date.now(), kind, msg, symbol })
  if (st.activity.length > ACTIVITY_CAP) st.activity.splice(0, st.activity.length - ACTIVITY_CAP)
}

export function addTrade(st: ServerlessState, t: TradeDoc): void {
  st.trades.unshift(t)
  if (st.trades.length > TRADES_CAP) st.trades.splice(TRADES_CAP)
}

export function nextId(st: ServerlessState, prefix: string): string {
  st.seq += 1
  return prefix + '-' + Date.now().toString(36) + '-' + st.seq.toString(36)
}

export function runEndsAt(st: ServerlessState): number {
  return st.run.startedAt > 0 ? st.run.startedAt + st.run.minutes * 60_000 : 0
}

export function runActive(st: ServerlessState): boolean {
  const end = runEndsAt(st)
  return end > 0 && Date.now() < end
}
