// Configuration loader: reads a .env file at the repo root, then applies
// real environment variables on top (process.env wins).
// No external dependency: small hand-rolled parser.

import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// src/config -> repo root is three levels up.
const repoRoot = join(here, '..', '..', '..')

function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of [join(repoRoot, '.env'), join(repoRoot, 'backend', '.env')]) {
    if (!existsSync(p)) continue
    for (const rawLine of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line.length === 0 || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const k = line.slice(0, eq).trim()
      let v = line.slice(eq + 1).trim()
      // strip inline comments and quotes
      const hash = v.indexOf(' #')
      if (hash > 0) v = v.slice(0, hash).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      out[k] = v
    }
  }
  return out
}

export interface AppConfig {
  port: number
  apiKey: string
  apiSecret: string
  privateBaseUrl: string
  publicBaseUrl: string
  symbols: string[]
  riskPct: number
  maxRiskPct: number
  dailyLossWarnPct: number
  dailyLossLimitPct: number
  maxConcurrent: number
  maxTradesPerSymbolPerDay: number
  setupsPer4h: number
  cooldownMinutes: number
  defaultRiskReward: number
  rrMin: number
  rrMax: number
  atrMult: number
  minStopPct: number
  maxBuyingPowerPct: number
  correlationCap: number
  volumeMult: number
  orderChunkThresholdUsd: number
  trailingStop: boolean
  breakeven: boolean
  partialProfit: boolean
  timeExitHours: number
  paper: boolean
  paperCash: number
  makerBps: number
  takerBps: number
  slipBps: number
  scanIntervalSec: number
  manageIntervalSec: number
  staleMs: number
  quietFirstMinutes: number
  lowVolumeHours: [number, number]
  minDepthUsd: number
  maxSpreadBps: number
  minAvailableUsd: number
  rrAbort: number
  apiAuthToken: string
  encryptionKey: Buffer | undefined
  dataDir: string
}

function num(env: Record<string, string>, key: string, def: number): number {
  const v = env[key]
  if (v === undefined || v === '') return def
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error('Invalid number for ' + key + ': ' + v)
  return n
}

function str(env: Record<string, string>, key: string, def: string): string {
  const v = env[key]
  return v === undefined ? def : v
}

function bool(env: Record<string, string>, key: string, def: boolean): boolean {
  const v = env[key]
  if (v === undefined || v === '') return def
  return v.toLowerCase() === 'true' || v === '1' || v.toLowerCase() === 'yes'
}

export function loadConfig(): AppConfig {
  const fileEnv = readEnvFile()
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(fileEnv)) env[k] = v
  // real environment variables always win (12-factor behavior), for any
  // variable the loader knows about
  for (const k of Object.keys(process.env)) {
    const pv = process.env[k]
    if (pv !== undefined && pv !== '' && /^[A-Z0-9_]+$/.test(k)) env[k] = pv
  }

  const encB64 = str(env, 'ENCRYPTION_KEY', '')
  const symbols = str(env, 'TRADING_SYMBOLS', 'btcusd,ethusd,solusd')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)

  return {
    port: num(env, 'PORT', 3000),
    apiKey: str(env, 'GEMINI_API_KEY', ''),
    apiSecret: str(env, 'GEMINI_API_SECRET', ''),
    privateBaseUrl: str(env, 'GEMINI_BASE_URL', 'https://api.sandbox.gemini.com').replace(/\/+$/, ''),
    publicBaseUrl: str(env, 'GEMINI_PUBLIC_BASE_URL', 'https://api.gemini.com').replace(/\/+$/, ''),
    symbols,
    riskPct: num(env, 'RISK_PER_TRADE_PCT', 1.5),
    maxRiskPct: num(env, 'MAX_RISK_PER_TRADE_PCT', 3.0),
    dailyLossWarnPct: num(env, 'DAILY_LOSS_WARNING_PCT', 3.0),
    dailyLossLimitPct: num(env, 'DAILY_LOSS_LIMIT_PCT', 5.0),
    maxConcurrent: num(env, 'MAX_CONCURRENT_POSITIONS', 3),
    maxTradesPerSymbolPerDay: num(env, 'MAX_TRADES_PER_SYMBOL_PER_DAY', 2),
    setupsPer4h: num(env, 'MAX_SETUPS_PER_SYMBOL_PER_4H', 1),
    cooldownMinutes: num(env, 'COOLDOWN_MINUTES', 30),
    // 5-minute ORB defaults (2026-validated): 1.5% fee-aware stop floor, 3R
    // target. 2026 full-year backtest: best config found; still selective in bears.
    defaultRiskReward: num(env, 'DEFAULT_RISK_REWARD', 3.0),
    rrMin: num(env, 'RISK_REWARD_MIN', 2.2),
    rrMax: num(env, 'RISK_REWARD_MAX', 10.0),
    atrMult: num(env, 'ATR_STOP_MULTIPLIER', 2.0),
    minStopPct: num(env, 'MIN_STOP_PCT', 1.5),
    maxBuyingPowerPct: num(env, 'MAX_BUYING_POWER_PCT', 30.0),
    correlationCap: num(env, 'CORRELATION_CAP', 0.85),
    volumeMult: num(env, 'MIN_VOLUME_MULTIPLIER', 1.5),
    orderChunkThresholdUsd: num(env, 'ORDER_CHUNK_THRESHOLD_USD', 1000),
    trailingStop: bool(env, 'TRAILING_STOP_ENABLED', true),
    breakeven: bool(env, 'BREAKEVEN_ENABLED', true),
    partialProfit: bool(env, 'PARTIAL_PROFIT_ENABLED', false),
    timeExitHours: num(env, 'TIME_EXIT_HOURS', 23),
    paper: bool(env, 'PAPER_TRADING', true),
    paperCash: num(env, 'PAPER_STARTING_CASH', 100),
    makerBps: num(env, 'MAKER_FEE_BPS', 20),
    takerBps: num(env, 'TAKER_FEE_BPS', 40),
    slipBps: num(env, 'SLIPPAGE_BPS', 2),
    scanIntervalSec: num(env, 'SCAN_INTERVAL_SEC', 60),
    manageIntervalSec: num(env, 'MANAGE_INTERVAL_SEC', 15),
    staleMs: num(env, 'STALE_PRICE_MS', 60000),
    quietFirstMinutes: num(env, 'QUIET_FIRST_MINUTES', 0),
    lowVolumeHours: [2, 6],
    minDepthUsd: num(env, 'MIN_DEPTH_USD', 5000),
    maxSpreadBps: num(env, 'MAX_SPREAD_BPS', 10),
    minAvailableUsd: num(env, 'MIN_AVAILABLE_USD', 10),
    rrAbort: num(env, 'RR_ABORT_MIN', 1.2),
    apiAuthToken: str(env, 'API_AUTH_TOKEN', ''),
    // Normalized to a 32-byte AES key: any ENCRYPTION_KEY string is hashed.
    encryptionKey: encB64 === '' ? undefined : createHash('sha256').update(encB64).digest(),
    dataDir: join(repoRoot, 'backend', 'data')
  }
}
