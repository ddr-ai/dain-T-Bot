// Fee-inclusive backtest CLI for the 5-minute session opening-range (ORB)
// method, with walk-forward parameter selection and a Monte Carlo drawdown
// resampling. Usage:
//   npm run backtest -- --symbol btcusd
//   npm run backtest -- --symbol btcusd --candles-file dump.json
// Data: Gemini public v2 5-minute candles. If the public endpoint caps
// history, provide a JSON file of raw v2 5m candle rows via --candles-file
// to backtest deeper. Results are printed to stdout and written to
// backend/data/backtest-report.json.
// NOTE: includes maker/taker fees + slippage per the validation requirements.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config/env.ts'
import { GeminiPublic } from '../gemini/public.ts'
import type { Candle } from '../gemini/types.ts'
import type { AppConfig } from '../config/env.ts'

const DAY_MS = 86_400_000
const FIVE_MIN_MS = 300_000

interface BackTestTrade {
  sessionStart: number
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
  param: { rr: number, minStopPct: number }
}

// Zarattini & Aziz first-candle ORB, long-only session simulation:
// for each UTC day (weekdays only), if the first 5m candle closes bullish,
// enter at the open of the second candle, stop at the first candle's low
// (floored at minStopPct), target rr x stop, and exit at the session close
// if neither is hit. Fees + slippage on both legs.
function simulate(
  c5m: Candle[],
  cfg: AppConfig,
  rr: number,
  minStopPct: number
): SimResult {
  const trades: BackTestTrade[] = []
  let equity = 0
  let peak = 0
  let maxDD = 0
  let feesTotal = 0
  const entryFeePct = (cfg.makerBps + cfg.slipBps) / 10000
  const exitFeePct = (cfg.takerBps + cfg.slipBps) / 10000

  let i = 0
  while (i < c5m.length) {
    const sessionStart = Math.floor(c5m[i].t / DAY_MS) * DAY_MS
    const weekday = new Date(sessionStart).getUTCDay()
    const first = c5m[i]

    // first candle of the session, weekday, bullish -> candidate
    if (first.t === sessionStart && weekday !== 0 && weekday !== 6 && first.c > first.o) {
      const entryBar = c5m[i + 1]
      if (entryBar && entryBar.t === sessionStart + FIVE_MIN_MS) {
        const entry = entryBar.o
        const stopDist = Math.max(entry - first.l, entry * (minStopPct / 100))
        const stop = entry - stopDist
        const target = entry + stopDist * rr
        feesTotal += entryFeePct + exitFeePct
        let exit: number | null = null
        let outcome: BackTestTrade['outcome'] = 'timeout'
        let tsExit = entryBar.t
        for (let j = i + 1; j < c5m.length; j++) {
          const f = c5m[j]
          if (f.t >= sessionStart + DAY_MS) break // session over
          tsExit = f.t
          if (f.l <= stop) {
            exit = stop * (1 - cfg.slipBps / 10000)
            outcome = 'stop'
            break
          }
          if (f.h >= target) {
            exit = target
            outcome = 'target'
            break
          }
        }
        if (exit === null) {
          // run to the last bar of the session (or end of data)
          let last = entryBar
          for (let j = i + 1; j < c5m.length; j++) {
            if (c5m[j].t >= sessionStart + DAY_MS) break
            last = c5m[j]
          }
          exit = last.c
          tsExit = last.t
          outcome = 'timeout'
        }
        const netPct = (exit - entry) / entry - entryFeePct - exitFeePct
        equity += netPct
        if (equity > peak) peak = equity
        const dd = peak - equity
        if (dd > maxDD) maxDD = dd
        trades.push({ sessionStart, entry, exit, pnlPct: netPct, outcome, tsEntry: entryBar.t, tsExit })
      }
    }

    // advance to the next session
    while (i < c5m.length && Math.floor(c5m[i].t / DAY_MS) * DAY_MS === sessionStart) i++
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
    param: { rr, minStopPct }
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

  const pub = new GeminiPublic(cfg.publicBaseUrl)
  let c5m: Candle[]
  if (file && existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const rows = Array.isArray(raw) && Array.isArray((raw as unknown[])[0]) ? (raw[0] as unknown[]) : raw
    c5m = (rows as unknown[]).map((r) => {
      const row = r as number[]
      return { t: row[0], o: row[1], h: row[2], l: row[3], c: row[4], v: row[5] }
    })
  } else {
    c5m = await pub.candles(symbol, '5m')
  }
  c5m.sort((a, b) => a.t - b.t)
  console.log('Backtesting ' + symbol + ' (5m session ORB): ' + c5m.length + ' candles (' + new Date(c5m[0].t).toISOString().slice(0, 10) + ' -> ' + new Date(c5m[c5m.length - 1].t).toISOString().slice(0, 10) + ')')

  // Walk-forward: split train 70% / validate 30%, small parameter grid.
  const split = Math.floor(c5m.length * 0.7)
  const train = c5m.slice(0, split)
  const validate = c5m.slice(split)
  const grid = [
    { rr: 5, minStopPct: 0.8 },
    { rr: 8, minStopPct: 0.8 },
    { rr: 10, minStopPct: 0.8 },
    { rr: 10, minStopPct: 1.2 }
  ]
  let best: SimResult | undefined
  for (const g of grid) {
    const r = simulate(train, cfg, g.rr, g.minStopPct)
    const score = r.profitFactor === Infinity ? 999 : r.profitFactor
    console.log('  TRAIN rr' + g.rr + ' stopFloor' + g.minStopPct + '%: trades ' + r.trades.length + ' PF ' + score.toFixed(2) + ' maxDD ' + fmt(r.maxDrawdownPct))
    if (!best || score > (best.profitFactor === Infinity ? 999 : best.profitFactor)) best = r
  }
  const chosen = best?.param ?? { rr: 10, minStopPct: 0.8 }
  const test = simulate(validate, cfg, chosen.rr, chosen.minStopPct)
  console.log('WALK-FORWARD VALIDATION (rr' + chosen.rr + ' stopFloor' + chosen.minStopPct + '%)')
  console.log('  trades: ' + test.trades.length)
  console.log('  win rate: ' + fmt(test.winRate, 1))
  console.log('  profit factor: ' + (test.profitFactor === Infinity ? 'inf' : test.profitFactor.toFixed(2)))
  console.log('  avg win/loss: ' + fmt(test.avgWin) + ' / ' + fmt(test.avgLoss))
  console.log('  total P&L: ' + fmt(test.pnlPct))
  console.log('  max drawdown: ' + fmt(test.maxDrawdownPct))

  const all = [...train, ...validate]
  const full = simulate(all, cfg, chosen.rr, chosen.minStopPct)
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

  const report = { symbol, candles: c5m.length, chosen, test, monteCarlo: mc, generatedAt: Date.now() }
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
