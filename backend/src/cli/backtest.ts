// Fee-inclusive backtest CLI with walk-forward parameter selection and a
// Monte Carlo drawdown resampling. Usage:
//   npm run backtest -- --symbol btcusd
//   npm run backtest -- --symbol btcusd --candles-file dump.json
// Data: Gemini public v2 candles (1m signal frame and 5m trend frame). If the
// public endpoint caps history, provide a JSON file of raw v2 candle rows via
// --candles-file to backtest deeper. Results are printed to stdout and written
// to backend/data/backtest-report.json.
// NOTE: includes maker/taker fees + slippage per the validation requirements.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config/env.ts'
import { GeminiPublic } from '../gemini/public.ts'
import { evaluateSetup } from '../strategy/signals.ts'
import type { Candle } from '../gemini/types.ts'
import type { AppConfig } from '../config/env.ts'

interface BackTestTrade {
  entryIdx: number
  entry: number
  exit: number
  pnlPct: number
  outcome: 'stop' | 'target' | 'timeout'
  tsEntry: number
  tsExit: number
}

interface SimResult {
  trades: BackTestTrade[]
  pnlPct: number
  winRate: number
  profitFactor: number
  avgWin: number
  avgLoss: number
  maxDrawdownPct: number
  feesPct: number
  param: { volumeMult: number, atrMult: number }
}

function simulate(
  c1m: Candle[],
  c5m: Candle[],
  cfg: AppConfig,
  volumeMult: number,
  atrMult: number,
  rr: number
): SimResult {
  const trades: BackTestTrade[] = []
  let cooldownIdx = -Infinity
  let equity = 0
  let peak = 0
  let maxDD = 0
  let feesTotal = 0

  for (let i = 80; i < c1m.length; i++) {
    const nowMs = c1m[i].t + 60_000 // evaluated at candle close
    if (i - cooldownIdx < 5) continue // 5-minute cooldown between entries
    const window = c1m.slice(0, i + 1)
    const window5m = c5m.filter((c) => c.t + 300_000 <= nowMs + 60_000)
    const decision = evaluateSetup(window, window5m, nowMs, {
      atrMult,
      minStopPct: cfg.minStopPct,
      volumeMult
    })
    if (!decision.enter || !Number.isFinite(decision.stopDist)) continue
    cooldownIdx = i
    const entry = c1m[i].c
    const stop = entry - decision.stopDist
    const target = entry + decision.stopDist * rr
    // fee + slippage model (both legs)
    const entryFeePct = (cfg.makerBps + cfg.slipBps) / 10000
    const exitFeePct = (cfg.takerBps + cfg.slipBps) / 10000
    feesTotal += entryFeePct + exitFeePct
    let exit: number | null = null
    let outcome: BackTestTrade['outcome'] = 'timeout'
    // walk forward candle by candle, time exit at 1.5h (90 one-minute bars)
    for (let j = i + 1; j < Math.min(c1m.length, i + 90) && exit === null; j++) {
      const f = c1m[j]
      if (f.l <= stop) {
        exit = stop * (1 - cfg.slipBps / 10000)
        outcome = 'stop'
      } else if (f.h >= target) {
        exit = target
        outcome = 'target'
      } else if (j === Math.min(c1m.length - 1, i + 90 - 1)) {
        exit = f.c
        outcome = 'timeout'
      }
    }
    if (exit === null) exit = c1m[c1m.length - 1].c
    const netPct = (exit - entry) / entry - entryFeePct - exitFeePct
    equity += netPct
    if (equity > peak) peak = equity
    const dd = peak - equity
    if (dd > maxDD) maxDD = dd
    trades.push({ entryIdx: i, entry, exit, pnlPct: netPct, outcome, tsEntry: c1m[i].t, tsExit: c1m[Math.min(c1m.length - 1, i + 90)].t })
  }

  const wins = trades.filter((t) => t.pnlPct > 0)
  const losses = trades.filter((t) => t.pnlPct <= 0)
  const gw = wins.reduce((s, t) => s + t.pnlPct, 0)
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0))
  const sorted = trades.slice().sort((a, b) => a.tsExit - b.tsExit)
  let cum = 0
  let pk = 0
  let mdd = 0
  for (const t of sorted) {
    cum += t.pnlPct
    if (cum > pk) pk = cum
    const d = pk - cum
    if (d > mdd) mdd = d
  }
  return {
    trades: sorted,
    pnlPct: sorted.reduce((s, t) => s + t.pnlPct, 0),
    winRate: trades.length === 0 ? 0 : wins.length / trades.length,
    profitFactor: gl === 0 ? (gw > 0 ? Infinity : 0) : gw / gl,
    avgWin: wins.length === 0 ? 0 : gw / wins.length,
    avgLoss: losses.length === 0 ? 0 : gl / losses.length,
    maxDrawdownPct: mdd,
    feesPct: feesTotal,
    param: { volumeMult, atrMult }
  }
}

// Deterministic LCG Monte Carlo: shuffle the trade sequence 1000 times.
function monteCarlo(trades: number[], runs = 1000, seed = 42): { worstDrawdown: number, p5Drawdown: number, ruinRisk: number } {
  let state = seed
  const rnd = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
  const dds: number[] = []
  let ruin = 0
  for (let run = 0; run < runs; run++) {
    const arr = trades.slice()
    // Fisher-Yates with LCG
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      const tmp = arr[i]
      arr[i] = arr[j]
      arr[j] = tmp
    }
    let cum = 0
    let pk = 0
    let dd = 0
    for (const v of arr) {
      cum += v
      if (cum > pk) pk = cum
      const d = pk - cum
      if (d > dd) dd = d
    }
    if (cum <= -100) ruin++ // sequence that wipes the account
    dds.push(dd)
  }
  dds.sort((a, b) => a - b)
  return {
    worstDrawdown: dds[dds.length - 1] ?? 0,
    p5Drawdown: dds[Math.floor(dds.length * 0.95)] ?? 0,
    ruinRisk: ruin / runs
  }
}

function fmt(n: number, digits = 2): string {
  return (n * 100).toFixed(digits) + '%'
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  const args = process.argv.slice(2)
  const get = (k: string): string | undefined => {
    const i = args.indexOf('--' + k)
    return i >= 0 ? args[i + 1] : undefined
  }
  const symbol = (get('symbol') ?? 'btcusd').toLowerCase()
  const file = get('candles-file')
  const cfgRr = cfg.defaultRiskReward

  const pub = new GeminiPublic(cfg.publicBaseUrl)
  let c1m: Candle[]
  const c5m = await pub.candles(symbol, '5m')
  if (file && existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const rows = Array.isArray(raw) && Array.isArray((raw as unknown[])[0]) ? (raw[0] as unknown[]) : raw
    c1m = (rows as unknown[]).map((r) => {
      const row = r as number[]
      return { t: row[0], o: row[1], h: row[2], l: row[3], c: row[4], v: row[5] }
    })
  } else {
    c1m = await pub.candles(symbol, '1m')
  }
  c1m.sort((a, b) => a.t - b.t)
  console.log('Backtesting ' + symbol + ': ' + c1m.length + ' 1m candles (' + new Date(c1m[0].t).toISOString().slice(0, 10) + ' -> ' + new Date(c1m[c1m.length - 1].t).toISOString().slice(0, 10) + '), ' + c5m.length + ' 5m candles')

  // Walk-forward: split train 70% / validate 30%, small parameter grid.
  const split = Math.floor(c1m.length * 0.7)
  const train = c1m.slice(0, split)
  const validate = c1m.slice(split)
  const grid = [
    { volumeMult: 1.3, atrMult: 1.25 },
    { volumeMult: 1.5, atrMult: 1.5 },
    { volumeMult: 2.0, atrMult: 1.75 },
    { volumeMult: cfg.volumeMult, atrMult: cfg.atrMult }
  ]
  let best: SimResult | undefined
  for (const g of grid) {
    const r = simulate(train, c5m, cfg, g.volumeMult, g.atrMult, cfgRr)
    const score = r.profitFactor === Infinity ? 999 : r.profitFactor
    console.log('  TRAIN volx' + g.volumeMult + ' atrx' + g.atrMult + ': trades ' + r.trades.length + ' PF ' + score.toFixed(2) + ' maxDD ' + fmt(r.maxDrawdownPct))
    if (!best || score > (best.profitFactor === Infinity ? 999 : best.profitFactor)) best = r
  }
  const chosen = best?.param ?? { volumeMult: cfg.volumeMult, atrMult: cfg.atrMult }
  const test = simulate(validate, c5m, cfg, chosen.volumeMult, chosen.atrMult, cfgRr)
  console.log('WALK-FORWARD VALIDATION (params volx' + chosen.volumeMult + ' atrx' + chosen.atrMult + ')')
  console.log('  trades: ' + test.trades.length)
  console.log('  win rate: ' + fmt(test.winRate, 1))
  console.log('  profit factor: ' + (test.profitFactor === Infinity ? 'inf' : test.profitFactor.toFixed(2)))
  console.log('  avg win/loss: ' + fmt(test.avgWin) + ' / ' + fmt(test.avgLoss))
  console.log('  total P&L: ' + fmt(test.pnlPct))
  console.log('  max drawdown: ' + fmt(test.maxDrawdownPct))

  const all = [...train, ...validate]
  const full = simulate(all, c5m, cfg, chosen.volumeMult, chosen.atrMult, cfgRr)
  const mc = monteCarlo(full.trades.map((t) => t.pnlPct))
  console.log('MONTE CARLO (1000 shuffles of the trade sequence)')
  console.log('  worst drawdown: ' + fmt(mc.worstDrawdown))
  console.log('  95th percentile drawdown: ' + fmt(mc.p5Drawdown))
  console.log('  ruin (wipe to -100%) sequences: ' + (mc.ruinRisk * 100).toFixed(2) + '%')
  if (mc.ruinRisk > 0.01) {
    console.log('  WARNING: ruin sequences detected - reduce RISK_PER_TRADE before live trading.')
  }
  if (test.profitFactor < 1 || test.trades.length < 10) {
    console.log('  WARNING: validation not profitable / too few trades - do NOT enable live autopilot on this basis.')
  }

  const report = { symbol, candles: c1m.length, chosen, test, monteCarlo: mc, generatedAt: Date.now() }
  const here = dirname(fileURLToPath(import.meta.url))
  const outDir = join(here, '..', '..', 'data')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'backtest-report.json'), JSON.stringify(report, null, 2))
  console.log('report written to backend/data/backtest-report.json')
}

main().catch((e) => {
  console.error('backtest failed: ' + String((e as Error).stack ?? e))
  process.exit(1)
})
