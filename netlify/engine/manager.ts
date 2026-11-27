// Auto trade management for the serverless engine - a faithful port of
// backend/src/engine/tradeManager.ts. Runs on EVERY engine tick regardless of
// the autopilot switch, so open positions are always managed even after a run
// window ends or the user taps STOP:
//   * stop-loss + take-profit REST on the exchange (poll fills each tick)
//   * OCO emulation: one side fills -> sibling cancelled
//   * breakeven stop move at +1R, trailing stop at 0.5 x ATR
//   * optional partial profit at +1R
//   * time-based exit when the 1h trend has flipped

import { CONFIG } from './config.ts'
import type { ServerlessState, PositionDoc, TradeDoc } from './state.ts'
import { addActivity } from './state.ts'
import type { GeminiCreds } from './blobs.ts'
import { priceOf, details } from './gemini.ts'
import {
  paperPollFills, paperPlaceStop, paperPlaceTarget, paperCancelOrder, paperCancelAll, paperSellNow,
  livePollFills, livePlaceStop, livePlaceTarget, cancelLiveOrder, cancelAllFor, liveSellNow
} from './brokers.ts'

export interface TickContext {
  st: ServerlessState
  creds: GeminiCreds | undefined
}

export async function manageAll(ctx: TickContext): Promise<void> {
  const positions = ctx.st.positions.slice()
  for (const pos of positions) {
    try {
      await manageOne(ctx, pos)
    } catch (e) {
      addActivity(ctx.st, 'error', 'manage ' + pos.symbol + ' failed: ' + String((e as Error).message), pos.symbol)
    }
  }
}

async function manageOne(ctx: TickContext, pos: PositionDoc): Promise<void> {
  const st = ctx.st
  const price = priceOf(st, pos.symbol)
  if (!price || !Number.isFinite(price) || price <= 0) return

  // 1. Detect stop/target fills (exchange-side or simulated).
  if (pos.mode === 'paper') {
    const fills = paperPollFills(st, pos, price)
    for (const f of fills) await recordExit(ctx, pos, f)
    if (pos.remainingQty <= 1e-12) return
  } else if (ctx.creds) {
    const fills = await livePollFills(ctx.creds, pos)
    for (const f of fills) {
      const reason = f.kind === 'stop' ? (pos.breakevenDone ? 'stop (breakeven/trailing) hit' : 'stop-loss hit') : 'take-profit hit'
      await recordExit(ctx, pos, f)
      // OCO emulation: cancel the sibling order.
      const sibling = f.kind === 'stop' ? pos.targetOrderId : pos.stopOrderId
      pos.stopOrderId = f.kind === 'stop' ? null : pos.stopOrderId
      pos.targetOrderId = f.kind === 'target' ? null : pos.targetOrderId
      if (sibling) await cancelLiveOrder(ctx.creds, sibling)
    }
    if (pos.remainingQty <= 1e-12) return
  } else {
    return // live position but creds vanished: manage again once creds return
  }

  const det = await details(pos.symbol).catch(() => undefined)
  if (!det) return
  const rMultiple = (price - pos.entry) / pos.stopDist
  const now = Date.now()

  // 2. Partial profit at +1R (optional).
  if (CONFIG.partialProfit && !pos.partialDone && rMultiple >= 1) {
    const half = Math.floor((pos.remainingQty / 2) / det.tickSize) * det.tickSize
    if (half >= det.tickSize && pos.remainingQty - half >= det.tickSize) {
      const sold = pos.mode === 'paper'
        ? paperSellNow(st, pos.symbol, half, price, det.tickSize)
        : ctx.creds ? await liveSellNow(ctx.creds, pos.symbol, half, price, det.tickSize, det.quoteIncrement) : undefined
      if (sold) {
        pos.partialDone = true
        await recordExit(ctx, pos, { kind: 'target', orderId: '', qty: sold.qty, price: sold.avgPrice, feeUsd: sold.feeUsd }, 'partial profit at +1R')
      }
    }
  }
  if (pos.remainingQty <= 1e-12) return

  // 3. Breakeven move at +1R (stop to entry + fee buffer).
  if (CONFIG.breakeven && !pos.breakevenDone && rMultiple >= 1) {
    const buffer = (CONFIG.makerBps + CONFIG.takerBps + CONFIG.slipBps * 2) / 10000
    const bePrice = pos.entry * (1 + buffer)
    if (bePrice > pos.stop) {
      const moved = await replaceStop(ctx, pos, bePrice, det.tickSize, det.quoteIncrement)
      if (moved) {
        pos.breakevenDone = true
        addActivity(st, 'stop', pos.symbol + ' stop moved to breakeven ' + pos.stop.toFixed(2), pos.symbol)
      }
    } else {
      pos.breakevenDone = true
    }
  }
  if (pos.remainingQty <= 1e-12) return

  // 4. Trailing stop once past +1R: half the entry ATR below price, but
  //    never tighter than a quarter of the stop distance (the 1-minute
  //    method's ATR is tiny; trailing on it alone would exit on noise).
  if (CONFIG.trailingStop && pos.breakevenDone && rMultiple >= 1 && Number.isFinite(pos.atr)) {
    const trailDist = Math.max(pos.atr * 0.5, pos.stopDist * 0.25)
    const newStop = price - trailDist
    if (newStop > pos.stop + trailDist * 0.2) {
      const moved = await replaceStop(ctx, pos, newStop, det.tickSize, det.quoteIncrement)
      if (moved) {
        addActivity(st, 'stop', pos.symbol + ' trailing stop raised to ' + pos.stop.toFixed(2), pos.symbol)
      }
    }
  }

  // 5. Time-based exit: after TIME_EXIT_HOURS, exit if the trend flipped.
  const ageH = (now - pos.openedAt) / 3600000
  if (ageH >= CONFIG.timeExitHours) {
    const trend = st.trendLong[pos.symbol]
    if (trend === false) {
      const sold = pos.mode === 'paper'
        ? paperSellNow(st, pos.symbol, pos.remainingQty, price, det.tickSize)
        : ctx.creds ? await liveSellNow(ctx.creds, pos.symbol, pos.remainingQty, price, det.tickSize, det.quoteIncrement) : undefined
      if (sold) {
        await recordExit(ctx, pos, { kind: 'target', orderId: '', qty: sold.qty, price: sold.avgPrice, feeUsd: sold.feeUsd }, 'time exit: 1h trend flipped')
        await cancelBoth(pos, ctx)
      }
    }
  }
}

async function replaceStop(ctx: TickContext, pos: PositionDoc, newStopIn: number, step: number, quoteIncrement: number): Promise<boolean> {
  const st = ctx.st
  let newStop = Math.floor(newStopIn / quoteIncrement) * quoteIncrement
  if (newStop <= 0) return false
  if (pos.mode === 'paper') {
    if (pos.stopOrderId) paperCancelOrder(st, pos.symbol, pos.stopOrderId)
    pos.stopOrderId = paperPlaceStop(st, pos.symbol, pos.remainingQty, newStop)
    pos.stop = newStop
    return true
  }
  if (!ctx.creds) return false
  if (pos.stopOrderId) await cancelLiveOrder(ctx.creds, pos.stopOrderId)
  pos.stopOrderId = null
  try {
    pos.stopOrderId = await livePlaceStop(ctx.creds, pos.symbol, pos.remainingQty, newStop, step, quoteIncrement)
    pos.stop = newStop
    return true
  } catch (e) {
    addActivity(st, 'error', 'replaceStop failed on ' + pos.symbol + ': ' + String((e as Error).message), pos.symbol)
    return false
  }
}

// Record a realized exit chunk on the position + trade doc.
export async function recordExit(
  ctx: TickContext,
  pos: PositionDoc,
  fill: { kind: 'stop' | 'target', qty: number, price: number, feeUsd: number },
  reasonOverride?: string
): Promise<void> {
  const st = ctx.st
  let qty = Math.min(fill.qty, pos.remainingQty)
  if (qty <= 0) return
  const reason = reasonOverride ?? (fill.kind === 'stop' ? (pos.breakevenDone ? 'stop (breakeven/trailing) hit' : 'stop-loss hit') : 'take-profit hit')
  const grossPnl = (fill.price - pos.entry) * qty
  pos.remainingQty = Math.max(0, pos.remainingQty - qty)
  st.daily.realizedPnl += grossPnl
  st.daily.realizedFees += fill.feeUsd

  const trade = findTrade(st, pos.id)
  if (trade) {
    trade.exits.push({ qty, price: fill.price, feeUsd: fill.feeUsd, reason, ts: Date.now() })
    trade.realizedQty += qty
    trade.feesUsd += fill.feeUsd
    trade.pnlUsd += grossPnl - fill.feeUsd
    const totalExitQty = Math.max(1e-12, trade.exits.reduce((s2, e) => s2 + e.qty, 0))
    trade.exit = trade.exits.reduce((s2, e) => s2 + e.price * e.qty, 0) / totalExitQty
    trade.exitReason = reason
  }

  addActivity(st, 'exit', 'CLOSED part: ' + pos.symbol + ' ' + qty + ' @ ' + fill.price.toFixed(2) + ' (' + reason + ') pnl ' + (grossPnl - fill.feeUsd).toFixed(2) + ' USD', pos.symbol)

  if (pos.remainingQty <= 1e-12) {
    finishPosition(st, pos, reason)
  }
}

async function cancelBoth(pos: PositionDoc, ctx: TickContext): Promise<void> {
  const st = ctx.st
  if (pos.mode === 'paper') {
    if (pos.stopOrderId) paperCancelOrder(st, pos.symbol, pos.stopOrderId)
    if (pos.targetOrderId) paperCancelOrder(st, pos.symbol, pos.targetOrderId)
  } else if (ctx.creds) {
    if (pos.stopOrderId) await cancelLiveOrder(ctx.creds, pos.stopOrderId)
    if (pos.targetOrderId) await cancelLiveOrder(ctx.creds, pos.targetOrderId)
  }
  pos.stopOrderId = null
  pos.targetOrderId = null
}

function finishPosition(st: ServerlessState, pos: PositionDoc, reason: string): void {
  const i = st.positions.indexOf(pos)
  if (i >= 0) st.positions.splice(i, 1)
  const trade = findTrade(st, pos.id)
  if (trade) {
    trade.status = 'closed'
    trade.closedAt = Date.now()
    if (trade.exitReason === null) trade.exitReason = reason
  }
  const pnl = trade ? trade.pnlUsd : 0
  addActivity(st, 'exit', 'Position closed: ' + pos.symbol + ' reason ' + reason + ', realized ' + pnl.toFixed(2) + ' USD', pos.symbol)
}

function findTrade(st: ServerlessState, positionId: string): TradeDoc | undefined {
  for (const t of st.trades) {
    if (t.id === positionId) return t
  }
  return undefined
}

// Place the protective stop + target right after the entry fill. If the stop
// cannot be placed the position is immediately exited - an unprotected
// position must never exist (unchanged invariant from the standalone engine).
export async function ensureProtectiveOrders(ctx: TickContext, pos: PositionDoc): Promise<boolean> {
  const st = ctx.st
  const det = await details(pos.symbol)
  if (pos.mode === 'paper') {
    paperCancelAll(st, pos.symbol)
    pos.stopOrderId = paperPlaceStop(st, pos.symbol, pos.remainingQty, pos.stop)
    pos.targetOrderId = paperPlaceTarget(st, pos.symbol, pos.remainingQty, pos.target)
    addActivity(st, 'protect', 'PAPER protective orders on ' + pos.symbol + ': stop ' + pos.stop.toFixed(2) + ', target ' + pos.target.toFixed(2), pos.symbol)
    return true
  }
  if (!ctx.creds) return false
  try {
    await cancelAllFor(ctx.creds, pos.symbol)
  } catch {
    // stray-order cleanup is best-effort
  }
  let stopOk = true
  try {
    pos.stopOrderId = await livePlaceStop(ctx.creds, pos.symbol, pos.remainingQty, pos.stop, det.tickSize, det.quoteIncrement)
  } catch (e) {
    stopOk = false
    addActivity(st, 'error', 'placeStop failed on ' + pos.symbol + ': ' + String((e as Error).message), pos.symbol)
  }
  try {
    pos.targetOrderId = await livePlaceTarget(ctx.creds, pos.symbol, pos.remainingQty, pos.target, det.tickSize, det.quoteIncrement)
  } catch (e) {
    addActivity(st, 'error', 'placeTarget failed on ' + pos.symbol + ': ' + String((e as Error).message), pos.symbol)
  }
  if (!stopOk) {
    addActivity(st, 'error', 'STOP placement failed on ' + pos.symbol + ' - emergency exit', pos.symbol)
    await exitAtMarket(ctx, pos, 'emergency-exit (stop placement failed)')
    return false
  }
  addActivity(st, 'protect', 'Protective orders placed on ' + pos.symbol + ': stop ' + pos.stop.toFixed(2) + ', target ' + pos.target.toFixed(2), pos.symbol)
  return true
}

export async function exitAtMarket(ctx: TickContext, pos: PositionDoc, reason: string): Promise<void> {
  const st = ctx.st
  const det = await details(pos.symbol)
  await cancelBoth(pos, ctx)
  const price = priceOf(st, pos.symbol) ?? pos.entry
  const sold = pos.mode === 'paper'
    ? paperSellNow(st, pos.symbol, pos.remainingQty, price, det.tickSize)
    : ctx.creds ? await liveSellNow(ctx.creds, pos.symbol, pos.remainingQty, price, det.tickSize, det.quoteIncrement) : undefined
  if (sold) {
    await recordExit(ctx, pos, { kind: 'stop', orderId: '', qty: sold.qty, price: sold.avgPrice, feeUsd: sold.feeUsd }, reason)
  } else {
    addActivity(st, 'error', 'EMERGENCY EXIT FAILED on ' + pos.symbol + ' - check Gemini manually', pos.symbol)
  }
}

// One-tap emergency stop: cancel orders, flatten, halt autopilot.
export async function emergencyStop(ctx: TickContext, reason: string): Promise<void> {
  const st = ctx.st
  st.settings.autopilotOn = false
  addActivity(st, 'emergency', 'EMERGENCY STOP: ' + reason + '. Cancelling orders and flattening.')
  const positions = st.positions.slice()
  for (const pos of positions) {
    await exitAtMarket(ctx, pos, 'emergency stop: ' + reason)
  }
  for (const symbol of CONFIG.symbols) {
    if (ctx.st.settings.paper) paperCancelAll(st, symbol)
    if (ctx.creds) await cancelAllFor(ctx.creds, symbol)
  }
}
