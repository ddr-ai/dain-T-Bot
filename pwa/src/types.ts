// Shared types matching the backend REST responses.

export interface SymbolTick {
  price: number
  at: number
}

export interface Position {
  id: string
  symbol: string
  mode: string
  qty: number
  remainingQty: number
  entry: number
  stop: number
  target: number
  stopDist: number
  riskUsd: number
  openedAt: number
  kind: string
  breakevenDone: boolean
  partialDone: boolean
  currentPrice: number | null
  unrealizedPnl: number | null
}

export interface Status {
  running: boolean
  autopilotOn: boolean
  mode: 'paper' | 'live'
  hasCredentials: boolean
  equity: number
  usdAvailable: number
  pnlToday: number
  pnlTodayPct: number
  dayStartEquity: number
  haltNew: boolean
  haltReason: string
  guardLock: boolean
  lastScanAt: number
  stalePrices: string[]
  positions: Position[]
  prices: Record<string, SymbolTick>
}

export interface Activity {
  ts: number
  kind: string
  msg: string
  symbol?: string
}

export interface Exit {
  qty: number
  price: number
  feeUsd: number
  reason: string
  ts: number
}

export interface Trade {
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
  exits: Exit[]
}

export interface Settings {
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
  riskRewardMin?: number
  riskRewardMax?: number
  maxRiskPct?: number
  symbols?: string[]
}

export interface Performance {
  trades: number
  openTrades: number
  winRate: number | null
  profitFactor: number | null
  avgWin: number | null
  avgLoss: number | null
  totalPnl: number
  maxDrawdown: number
  feesPaid: number
  todayRealized: number
  todayFees: number
  equityCurve: number[]
}

export interface WsEvent {
  t: 'price' | 'activity' | 'trade' | 'status' | 'settings'
  data: unknown
}
