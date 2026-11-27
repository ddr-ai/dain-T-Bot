// Serverless engine configuration. Mirrors the standalone backend's env
// defaults (backend/src/config/env.ts) with two intentional differences for
// the hosted deployment the user asked for:
//   * LIVE mode is the default (paper must be chosen explicitly)
//   * the private REST base is production Gemini, not the sandbox
// Everything else (risk caps, breakers, strategy constants) matches the
// tested standalone engine 1:1 so behavior is identical.

import type { AppConfig } from '../../backend/src/config/env.ts'

const num = (v: string | undefined, d: number): number => {
  const n = Number(v)
  return Number.isFinite(n) && n !== 0 ? n : d
}
const bool = (v: string | undefined, d: boolean): boolean => {
  if (v === undefined || v === '') return d
  return v.toLowerCase() === 'true' || v === '1' || v.toLowerCase() === 'yes'
}

export const CONFIG: AppConfig = {
  port: 3000,
  apiKey: '',
  apiSecret: '',
  privateBaseUrl: (process.env.GEMINI_BASE_URL ?? 'https://api.gemini.com').replace(/\/+$/, ''),
  publicBaseUrl: (process.env.GEMINI_PUBLIC_BASE_URL ?? 'https://api.gemini.com').replace(/\/+$/, ''),
  symbols: (process.env.TRADING_SYMBOLS ?? 'btcusd,ethusd,solusd')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0),
  riskPct: num(process.env.RISK_PER_TRADE_PCT, 1.5),
  maxRiskPct: num(process.env.MAX_RISK_PER_TRADE_PCT, 3.0),
  dailyLossWarnPct: num(process.env.DAILY_LOSS_WARNING_PCT, 3.0),
  dailyLossLimitPct: num(process.env.DAILY_LOSS_LIMIT_PCT, 5.0),
  maxConcurrent: num(process.env.MAX_CONCURRENT_POSITIONS, 3),
  maxTradesPerSymbolPerDay: num(process.env.MAX_TRADES_PER_SYMBOL_PER_DAY, 2),
  setupsPer4h: num(process.env.MAX_SETUPS_PER_SYMBOL_PER_4H, 1),
  cooldownMinutes: num(process.env.COOLDOWN_MINUTES, 30),
  // 5-minute ORB defaults: paper target 10R (Zarattini & Aziz); slider range [rrMin, rrMax];
  // the fee floor on stops keeps the net-RR abort gate honest.
  defaultRiskReward: num(process.env.DEFAULT_RISK_REWARD, 10.0),
  rrMin: num(process.env.RISK_REWARD_MIN, 2.2),
  rrMax: num(process.env.RISK_REWARD_MAX, 10.0),
  atrMult: num(process.env.ATR_STOP_MULTIPLIER, 2.0),
  minStopPct: num(process.env.MIN_STOP_PCT, 0.8),
  maxBuyingPowerPct: num(process.env.MAX_BUYING_POWER_PCT, 30),
  correlationCap: num(process.env.CORRELATION_CAP, 0.85),
  volumeMult: num(process.env.MIN_VOLUME_MULTIPLIER, 1.5),
  orderChunkThresholdUsd: num(process.env.ORDER_CHUNK_THRESHOLD_USD, 1000),
  trailingStop: bool(process.env.TRAILING_STOP_ENABLED, true),
  breakeven: bool(process.env.BREAKEVEN_ENABLED, true),
  partialProfit: bool(process.env.PARTIAL_PROFIT_ENABLED, false),
  timeExitHours: num(process.env.TIME_EXIT_HOURS, 23),
  paper: bool(process.env.PAPER_TRADING, false),
  paperCash: num(process.env.PAPER_STARTING_CASH, 100),
  makerBps: num(process.env.MAKER_FEE_BPS, 20),
  takerBps: num(process.env.TAKER_FEE_BPS, 40),
  slipBps: num(process.env.SLIPPAGE_BPS, 2),
  scanIntervalSec: 60,
  manageIntervalSec: 60,
  staleMs: num(process.env.STALE_PRICE_MS, 90000),
  quietFirstMinutes: num(process.env.QUIET_FIRST_MINUTES, 0),
  lowVolumeHours: [2, 6],
  minDepthUsd: num(process.env.MIN_DEPTH_USD, 5000),
  maxSpreadBps: num(process.env.MAX_SPREAD_BPS, 10),
  minAvailableUsd: num(process.env.MIN_AVAILABLE_USD, 10),
  rrAbort: num(process.env.RR_ABORT_MIN, 1.2),
  apiAuthToken: process.env.API_AUTH_TOKEN ?? '',
  encryptionKey: undefined,
  dataDir: ''
} as unknown as AppConfig

// Run-window constraints for the START/STOP flow: 1 hour to 7 days.
export const RUN_MINUTES_MIN = 60
export const RUN_MINUTES_MAX = 60 * 24 * 7
export const RUN_MINUTES_DEFAULT = 60 * 24
export const RUN_OPTIONS_MINUTES = [60, 180, 360, 720, 1440, 4320, 10080]
