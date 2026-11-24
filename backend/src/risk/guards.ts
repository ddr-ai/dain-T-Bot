// The hard risk-management guards. These override the strategy and can only
// be tightened at runtime, never loosened beyond the config caps.
// Invariants enforced here:
//   * never spend more than available USD (no negative balances, no margin)
//   * risk per trade capped, risk-reward slider affects TAKE-PROFIT only
//   * dry powder (buying power cap), concurrency caps, $10 minimum availability
//   * daily loss circuit breakers

import type { AppConfig } from '../config/env.ts'
import { floorToStep } from '../util/round.ts'

export interface SizingInput {
  equity: number
  usdAvailable: number
  committedUsd: number
  price: number
  stop: number
  step: number
  minNotionalUsd: number
  cfg: AppConfig
  riskPctOverride?: number
}

export interface SizingResult {
  ok: boolean
  reason?: string
  qty: number
  riskUsd: number
  costUsd: number
  entryFeeUsd: number
}

// Stop distance = max(ATR * multiplier, minStopPct% of price).
export function computeStopDist(price: number, atr: number, cfg: AppConfig): number {
  const atrPart = Number.isFinite(atr) ? atr * cfg.atrMult : 0
  return Math.max(atrPart, price * (cfg.minStopPct / 100))
}

export function clampRiskReward(rr: number, cfg: AppConfig): number {
  if (!Number.isFinite(rr)) return cfg.defaultRiskReward
  return Math.min(cfg.rrMax, Math.max(cfg.rrMin, rr))
}

// Kelly-lite sizing: position = riskBudget / stopDistance, rounded DOWN to step.
export function positionSize(input: SizingInput): SizingResult {
  const cfg = input.cfg
  const fail = (reason: string): SizingResult => ({ ok: false, reason, qty: 0, riskUsd: 0, costUsd: 0, entryFeeUsd: 0 })

  const riskPct = Math.min(input.riskPctOverride ?? cfg.riskPct, cfg.maxRiskPct)
  if (riskPct <= 0) return fail('risk percentage is zero')

  if (input.usdAvailable < cfg.minAvailableUsd) return fail('available USD ' + input.usdAvailable.toFixed(2) + ' below minimum ' + cfg.minAvailableUsd)

  const dist = input.price - input.stop
  if (!(dist > 0)) return fail('stop must be below entry for longs')

  const riskUsd = input.equity * (riskPct / 100)
  if (riskUsd <= 0) return fail('risk budget is zero')

  let qty = floorToStep(riskUsd / dist, input.step)
  if (qty < input.step) return fail('risk budget too small for symbol step size')

  const costUsd = qty * input.price
  const entryFeeUsd = (costUsd * cfg.makerBps) / 10000

  // Buying power cap: keep at least (100 - maxBuyingPowerPct)% dry.
  if (input.committedUsd + costUsd > (input.usdAvailable * cfg.maxBuyingPowerPct) / 100) {
    return fail('buying power cap: would commit ' + (input.committedUsd + costUsd).toFixed(2) + ' USD, cap ' + ((input.usdAvailable * cfg.maxBuyingPowerPct) / 100).toFixed(2))
  }

  // The $0 floor: projected available balance after fees must stay >= 0.
  const projected = input.usdAvailable - costUsd - entryFeeUsd
  if (projected < 0) return fail('order would push available balance below $0')

  if (costUsd < Math.min(input.minNotionalUsd, 5)) {
    return fail('order notional ' + costUsd.toFixed(2) + ' below exchange minimum ' + Math.min(input.minNotionalUsd, 5).toFixed(2))
  }

  // Halve size until it fits the remaining budget instead of aborting tiny accounts.
  let guard = 0
  while (qty >= input.step && input.usdAvailable - qty * input.price - (qty * input.price * cfg.makerBps) / 10000 < 0 && guard < 8) {
    qty = floorToStep(qty / 2, input.step)
    guard++
  }
  if (qty < input.step) return fail('cannot fit order inside available cash')

  return {
    ok: true,
    qty,
    riskUsd: qty * dist,
    costUsd: qty * input.price,
    entryFeeUsd
  }
}

export interface RrCheckInput {
  price: number
  stop: number
  qty: number
  riskReward: number
  cfg: AppConfig
}

export interface RrCheckResult {
  ok: boolean
  rrNet: number
  target: number
  reason?: string
}

// Reward target adjusted for fees + slippage; abort when net RR < 1.2.
export function rrAfterFees(input: RrCheckInput): RrCheckResult {
  const cfg = input.cfg
  const dist = input.price - input.stop
  const target = input.price + dist * input.riskReward
  const grossReward = dist * input.riskReward * input.qty
  const entryFee = input.qty * input.price * (cfg.makerBps / 10000)
  const exitFee = input.qty * target * (cfg.takerBps / 10000)
  const slip = (input.qty * input.price + input.qty * target) * (cfg.slipBps / 10000)
  const riskUsd = dist * input.qty
  if (riskUsd <= 0) return { ok: false, rrNet: 0, target, reason: 'zero risk' }
  const net = grossReward - exitFee - slip - entryFee
  const rrNet = net / riskUsd
  const ok = rrNet >= cfg.rrAbort
  return {
    ok,
    rrNet,
    target,
    reason: ok ? undefined : 'net risk:reward after fees/slippage ' + rrNet.toFixed(2) + ' below ' + cfg.rrAbort
  }
}

export type BreakerAction = 'ok' | 'halt-new' | 'flatten'

// Daily loss circuit breaker on realized + unrealized P&L percentage.
export function breakerAction(pnlPctToday: number, cfg: AppConfig): BreakerAction {
  if (pnlPctToday <= -Math.abs(cfg.dailyLossLimitPct)) return 'flatten'
  if (pnlPctToday <= -Math.abs(cfg.dailyLossWarnPct)) return 'halt-new'
  return 'ok'
}

// Correlation gate for the third coin vs BTC/ETH holdings.
export function correlationGateForEntry(
  symbol: string,
  holding: string[],
  correlations: Record<string, number>,
  cfg: AppConfig
): { ok: boolean, reason?: string } {
  if (holding.length === 0) return { ok: true }
  if (!holding.includes(symbol)) {
    // entering a new symbol while holding others: check correlation to each
    for (const h of holding) {
      const key = symbol + '|' + h
      const corr = correlations[key]
      if (Number.isFinite(corr) && Math.abs(corr) > 0.8) {
        return { ok: false, reason: 'correlation ' + corr.toFixed(2) + ' to held ' + h + ' exceeds 0.8' }
      }
    }
  }
  if (holding.length >= 2) {
    const corr = correlations[symbol]
    if (Number.isFinite(corr) && corr >= cfg.correlationCap) {
      return { ok: false, reason: '30d correlation ' + corr.toFixed(2) + ' to BTC >= cap ' + cfg.correlationCap }
    }
  }
  return { ok: true }
}
