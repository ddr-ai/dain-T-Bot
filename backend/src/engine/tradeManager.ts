// Auto trade management: everything that happens AFTER the entry.
//   * stop-loss + take-profit live on the exchange right after entry
//   * OCO emulation: when one side fills the sibling is cancelled
//   * breakeven move after +1R (no trailing stop - ORB winners run to target)
//   * optional partial profit at +1R
//   * unconditional time exit at TIME_EXIT_HOURS (session close)
// All moves are logged to the activity feed and pushed to clients.

import { log } from '../util/logger.ts'
import type { AppConfig } from '../config/env.ts'
import type { EventBus } from '../notify/events.ts'
import type { PositionDoc, Store, TradeDoc } from '../store/store.ts'
import type { Broker } from './broker.ts'
import type { SymbolDetails } from '../gemini/types.ts'

export interface TradeManagerDeps {
  cfg: AppConfig
  store: Store
  events: EventBus
  brokerFor: (mode: 'paper' | 'live') => Broker | undefined
  priceOf: (symbol: string) => number | undefined
  trendLongOf: (symbol: string) => boolean | null     // current 1h+15m long bias
  detailsOf: (symbol: string) => Promise<SymbolDetails>
}

export class TradeManager {
  constructor(private d: TradeManagerDeps) {}

  // Place the protective stop + target right after the entry fill.
  // If the stop cannot be placed the position is immediately exited -
  // an unprotected position must never exist.
  async ensureProtectiveOrders(pos: PositionDoc): Promise<boolean> {
    const broker = this.d.brokerFor(pos.mode)
    if (!broker) return false
    const det = await this.d.detailsOf(pos.symbol)
    // cancel any strays first (e.g. leftover maker buys)
    await broker.cancelAllFor(pos.symbol).catch(() => undefined)
    let stopOk = true
    try {
      const stop = await broker.placeStop(pos.symbol, pos.remainingQty, pos.stop, pos.entry, det.tickSize, det.quoteIncrement)
      pos.stopOrderId = stop ? stop.orderId : null
      if (!stop) stopOk = false
    } catch (e) {
      log.error('placeStop failed for ' + pos.symbol + ': ' + String((e as Error).message))
      stopOk = false
    }
    try {
      const target = await broker.placeTarget(pos.symbol, pos.remainingQty, pos.target, det.tickSize, det.quoteIncrement)
      pos.targetOrderId = target ? target.orderId : null
    } catch (e) {
      log.error('placeTarget failed for ' + pos.symbol + ': ' + String((e as Error).message))
    }
    if (!stopOk) {
      log.error('STOP placement failed on ' + pos.symbol + ' - emergency flattening the position')
      await this.exitAtMarket(pos, 'emergency-exit (stop placement failed)')
      this.d.store.addActivity('error', 'STOP placement failed on ' + pos.symbol + ' - emergency exit', pos.symbol)
      return false
    }
    this.d.store.saveSoon()
    this.d.store.addActivity('protect', 'Protective orders placed on ' + pos.symbol + ': stop ' + pos.stop.toFixed(2) + ', target ' + pos.target.toFixed(2), pos.symbol)
    return true
  }

  async manageAll(): Promise<void> {
    const positions = this.d.store.state.positions.slice()
    for (const pos of positions) {
      try {
        await this.manageOne(pos)
      } catch (e) {
        log.error('manage ' + pos.symbol + ' failed: ' + String((e as Error).message))
      }
    }
  }

  private async manageOne(pos: PositionDoc): Promise<void> {
    const broker = this.d.brokerFor(pos.mode)
    if (!broker) return
    const price = this.d.priceOf(pos.symbol)
    if (!price || !Number.isFinite(price) || price <= 0) return

    // 1. Detect stop/target fills (exchange-side or simulated).
    const fills = await broker.pollFills(pos, price)
    for (const f of fills) {
      const reason = f.kind === 'stop' ? (pos.breakevenDone ? 'stop (breakeven/trailing) hit' : 'stop-loss hit') : 'take-profit hit'
      await this.recordExit(pos, f.qty, f.price, f.feeUsd, reason)
      // OCO emulation: cancel the sibling order.
      const sibling = f.kind === 'stop' ? pos.targetOrderId : pos.stopOrderId
      pos.stopOrderId = f.kind === 'stop' ? null : pos.stopOrderId
      pos.targetOrderId = f.kind === 'target' ? null : pos.targetOrderId
      if (sibling) await broker.cancelOrder(sibling)
      this.d.events.emit('trade', { kind: 'exit', symbol: pos.symbol, reason, price: f.price, qty: f.qty })
    }
    if (pos.remainingQty <= 1e-12) return

    const det = await this.d.detailsOf(pos.symbol)
    const rMultiple = (price - pos.entry) / pos.stopDist
    const now = Date.now()

    // 2. Partial profit at +1R (optional).
    if (this.d.cfg.partialProfit && !pos.partialDone && rMultiple >= 1) {
      const half = Math.floor((pos.remainingQty / 2) / det.tickSize) * det.tickSize
      if (half >= det.tickSize && pos.remainingQty - half >= det.tickSize) {
        const sold = await broker.sellNow(pos.symbol, half, price, det.tickSize, det.quoteIncrement)
        if (sold) {
          pos.partialDone = true
          await this.recordExit(pos, sold.qty, sold.avgPrice, sold.feeUsd, 'partial profit at +1R')
        }
      }
    }
    if (pos.remainingQty <= 1e-12) return

    // 3. Breakeven move at +1R (stop to entry + fee buffer).
    if (this.d.cfg.breakeven && !pos.breakevenDone && rMultiple >= 1) {
      const buffer = (this.d.cfg.makerBps + this.d.cfg.takerBps + this.d.cfg.slipBps * 2) / 10000
      const bePrice = pos.entry * (1 + buffer)
      if (bePrice > pos.stop) {
        const moved = await this.replaceStop(pos, bePrice, det)
        if (moved) {
          pos.breakevenDone = true
          this.d.store.addActivity('stop', pos.symbol + ' stop moved to breakeven ' + pos.stop.toFixed(2), pos.symbol)
          this.d.events.emit('activity', { msg: pos.symbol + ' stop moved to breakeven ' + pos.stop.toFixed(2) })
        }
      } else {
        pos.breakevenDone = true
      }
    }
    if (pos.remainingQty <= 1e-12) return

    // 4. NO trailing stop: the ORB method's edge is letting winners run to
    //    the 10R target or the session close. Only the breakeven move above
    //    protects the position once it reaches +1R.

    // 5. Time-based exit: after TIME_EXIT_HOURS (session close for the ORB
    //    method), exit unconditionally - nothing carries into the next session.
    const ageH = (now - pos.openedAt) / 3600000
    if (ageH >= this.d.cfg.timeExitHours) {
      const sold = await broker.sellNow(pos.symbol, pos.remainingQty, price, det.tickSize, det.quoteIncrement)
      if (sold) {
        await this.recordExit(pos, sold.qty, sold.avgPrice, sold.feeUsd, 'time exit: session close (ORB)')
        await this.cancelBoth(pos, broker)
      }
    }
  }

  private async replaceStop(pos: PositionDoc, newStop: number, det: SymbolDetails): Promise<boolean> {
    const broker = this.d.brokerFor(pos.mode)
    if (!broker) return false
    newStop = Math.floor(newStop / det.quoteIncrement) * det.quoteIncrement
    if (newStop <= 0) return false
    if (pos.stopOrderId) {
      await broker.cancelOrder(pos.stopOrderId)
      pos.stopOrderId = null
    }
    try {
      const ref = this.d.priceOf(pos.symbol) ?? pos.entry
      const stop = await broker.placeStop(pos.symbol, pos.remainingQty, newStop, ref, det.tickSize, det.quoteIncrement)
      pos.stopOrderId = stop ? stop.orderId : null
      pos.stop = newStop
      this.d.store.saveSoon()
      return stop !== undefined
    } catch (e) {
      log.error('replaceStop failed on ' + pos.symbol + ': ' + String((e as Error).message))
      return false
    }
  }

  // Record a realized exit chunk on the position + trade doc.
  private async recordExit(pos: PositionDoc, qty: number, price: number, feeUsd: number, reason: string): Promise<void> {
    qty = Math.min(qty, pos.remainingQty)
    if (qty <= 0) return
    const grossPnl = (price - pos.entry) * qty
    pos.remainingQty = Math.max(0, pos.remainingQty - qty)
    const d = this.d.store.state.daily
    d.realizedPnl += grossPnl
    d.realizedFees += feeUsd

    const trade = this.findTrade(pos.id)
    if (trade) {
      trade.exits.push({ qty, price, feeUsd, reason, ts: Date.now() })
      trade.realizedQty += qty
      trade.feesUsd += feeUsd
      trade.pnlUsd += grossPnl - feeUsd
      const vwapExit = trade.exits.reduce((s, e) => s + e.price * e.qty, 0) / Math.max(1e-12, trade.exits.reduce((s, e) => s + e.qty, 0))
      trade.exit = vwapExit
      trade.exitReason = reason
    }

    const msg = 'CLOSED part: ' + pos.symbol + ' ' + qty + ' @ ' + price.toFixed(2) + ' (' + reason + ') pnl ' + (grossPnl - feeUsd).toFixed(2) + ' USD'
    this.d.store.addActivity('exit', msg, pos.symbol)

    if (pos.remainingQty <= 1e-12) {
      this.finishPosition(pos, reason)
    }
    this.d.store.saveSoon()
  }

  async exitAtMarket(pos: PositionDoc, reason: string): Promise<void> {
    const broker = this.d.brokerFor(pos.mode)
    if (!broker) return
    const det = await this.d.detailsOf(pos.symbol)
    await this.cancelBoth(pos, broker)
    const price = this.d.priceOf(pos.symbol) ?? pos.entry
    const sold = await broker.sellNow(pos.symbol, pos.remainingQty, price, det.tickSize, det.quoteIncrement)
    if (sold) {
      await this.recordExit(pos, sold.qty, sold.avgPrice, sold.feeUsd, reason)
    } else {
      log.error('emergency exit FAILED for ' + pos.symbol + ' - position may still be open on the exchange')
      this.d.store.addActivity('error', 'EMERGENCY EXIT FAILED on ' + pos.symbol + ' - check Gemini manually', pos.symbol)
    }
  }

  private async cancelBoth(pos: PositionDoc, broker: Broker): Promise<void> {
    if (pos.stopOrderId) await broker.cancelOrder(pos.stopOrderId).catch(() => undefined)
    if (pos.targetOrderId) await broker.cancelOrder(pos.targetOrderId).catch(() => undefined)
    pos.stopOrderId = null
    pos.targetOrderId = null
  }

  private finishPosition(pos: PositionDoc, reason: string): void {
    const i = this.d.store.state.positions.indexOf(pos)
    if (i >= 0) this.d.store.state.positions.splice(i, 1)
    const trade = this.findTrade(pos.id)
    if (trade) {
      trade.status = 'closed'
      trade.closedAt = Date.now()
      if (trade.exitReason === null) trade.exitReason = reason
    }
    const pnl = trade ? trade.pnlUsd : 0
    this.d.store.addActivity('exit', 'Position closed: ' + pos.symbol + ' reason ' + reason + ', realized ' + pnl.toFixed(2) + ' USD', pos.symbol)
    this.d.events.emit('trade', { kind: 'position-closed', symbol: pos.symbol, reason, pnlUsd: pnl })
  }

  private findTrade(positionId: string): TradeDoc | undefined {
    for (const t of this.d.store.state.trades) {
      if (t.id === positionId) return t
    }
    return undefined
  }
}
