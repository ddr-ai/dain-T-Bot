// Engine configuration for the Cloudflare Workers port. Same values and
// defaults as netlify/engine/config.ts (which mirrors backend/src/config/env.ts),
// with two intentional differences for the hosted deployment:
//   * LIVE mode is the default (paper must be chosen explicitly)
//   * the private REST base is production Gemini, not the sandbox
// Cloudflare Workers do not expose process.env, so the worker entry point
// injects the bindings (vars + secrets) through initEngineConfig() before
// any request or cron tick runs. CONFIG is a lazy proxy: the AppConfig is
// rebuilt on first access after each re-injection, and every engine module
// reads CONFIG only inside function bodies, never at module load time.

import type { AppConfig } from '../../backend/src/config/env.ts'

const num = (v: string | undefined, d: number): number => {
  const n = Number(v)
  return Number.isFinite(n) && n !== 0 ? n : d
}
const bool = (v: string | undefined, d: boolean): boolean => {
  if (v === undefined || v === '') return d
  return v.toLowerCase() === 'true' || v === '1' || v.toLowerCase() === 'yes'
}

// Injected by the worker entry point (fetch + scheduled) and the Durable
// Object constructor from the real `env` bindings object.
let env: Record<string, string> = {}

export function initEngineConfig(bindings: Record<string, unknown>): void {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(bindings ?? {})) {
    if (typeof v === 'string' && v.length > 0) out[k] = v
  }
  env = out
  cfgCache = undefined
}

export function getEnv(): Record<string, string> {
  return env
}

let cfgCache: AppConfig | undefined

function buildConfig(): AppConfig {
  return {
    port: 3000,
    apiKey: '',
    apiSecret: '',
    privateBaseUrl: (env.GEMINI_BASE_URL ?? 'https://api.gemini.com').replace(/\/+$/, ''),
    publicBaseUrl: (env.GEMINI_PUBLIC_BASE_URL ?? 'https://api.gemini.com').replace(/\/+$/, ''),
    symbols: (env.TRADING_SYMBOLS ?? 'btcusd,ethusd,solusd')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
    riskPct: num(env.RISK_PER_TRADE_PCT, 1.5),
    maxRiskPct: num(env.MAX_RISK_PER_TRADE_PCT, 3.0),
    dailyLossWarnPct: num(env.DAILY_LOSS_WARNING_PCT, 3.0),
    dailyLossLimitPct: num(env.DAILY_LOSS_LIMIT_PCT, 5.0),
    maxConcurrent: num(env.MAX_CONCURRENT_POSITIONS, 3),
    maxTradesPerSymbolPerDay: num(env.MAX_TRADES_PER_SYMBOL_PER_DAY, 2),
    setupsPer4h: num(env.MAX_SETUPS_PER_SYMBOL_PER_4H, 1),
    cooldownMinutes: num(env.COOLDOWN_MINUTES, 30),
    // 5-minute ORB defaults (2026-validated): 1.5% fee-aware stop floor, 3R
    // target. 2026 full-year backtest: best config found; still selective in bears.
    defaultRiskReward: num(env.DEFAULT_RISK_REWARD, 3.0),
    rrMin: num(env.RISK_REWARD_MIN, 2.2),
    rrMax: num(env.RISK_REWARD_MAX, 10.0),
    atrMult: num(env.ATR_STOP_MULTIPLIER, 2.0),
    minStopPct: num(env.MIN_STOP_PCT, 1.5),
    maxBuyingPowerPct: num(env.MAX_BUYING_POWER_PCT, 30),
    correlationCap: num(env.CORRELATION_CAP, 0.85),
    volumeMult: num(env.MIN_VOLUME_MULTIPLIER, 1.5),
    orderChunkThresholdUsd: num(env.ORDER_CHUNK_THRESHOLD_USD, 1000),
    trailingStop: bool(env.TRAILING_STOP_ENABLED, true),
    breakeven: bool(env.BREAKEVEN_ENABLED, true),
    partialProfit: bool(env.PARTIAL_PROFIT_ENABLED, false),
    timeExitHours: num(env.TIME_EXIT_HOURS, 23),
    paper: bool(env.PAPER_TRADING, false),
    paperCash: num(env.PAPER_STARTING_CASH, 100),
    makerBps: num(env.MAKER_FEE_BPS, 20),
    takerBps: num(env.TAKER_FEE_BPS, 40),
    slipBps: num(env.SLIPPAGE_BPS, 2),
    scanIntervalSec: 60,
    manageIntervalSec: 60,
    staleMs: num(env.STALE_PRICE_MS, 90000),
    quietFirstMinutes: num(env.QUIET_FIRST_MINUTES, 0),
    lowVolumeHours: [2, 6],
    minDepthUsd: num(env.MIN_DEPTH_USD, 5000),
    maxSpreadBps: num(env.MAX_SPREAD_BPS, 10),
    minAvailableUsd: num(env.MIN_AVAILABLE_USD, 10),
    rrAbort: num(env.RR_ABORT_MIN, 1.2),
    apiAuthToken: env.API_AUTH_TOKEN ?? '',
    encryptionKey: undefined,
    dataDir: ''
  } as unknown as AppConfig
}

// Lazy proxy: resolves CONFIG.<field> to the AppConfig built from the current
// injected bindings. Rebuilds at most once per injection.
export const CONFIG: AppConfig = new Proxy({} as AppConfig, {
  get(_target, prop: string): unknown {
    cfgCache ??= buildConfig()
    return (cfgCache as unknown as Record<string, unknown>)[prop]
  }
})

// Run-window constraints for the START/STOP flow: 1 hour to 7 days.
export const RUN_MINUTES_MIN = 60
export const RUN_MINUTES_MAX = 60 * 24 * 7
export const RUN_MINUTES_DEFAULT = 60 * 24
export const RUN_OPTIONS_MINUTES = [60, 180, 360, 720, 1440, 4320, 10080]
