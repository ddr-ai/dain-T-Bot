// Live broker: executes on the Gemini private REST API.
// Entry: post-only (maker-or-cancel) limit at the top bid, polled to completion.
// Stop: exchange stop-limit SELL with limit price slightly below the stop so
// it crosses and fills when triggered. Target: maker-or-cancel limit sell.
// Emergency exits: immediate-or-cancel sell just through the book.

import { log } from '../util/logger.ts'
import { climbToStep, decimalsOf, floorToStep } from '../util/round.ts'
import { sleepMs } from './util.ts'
import type { Broker } from './broker.ts'
import type { AppConfig } from '../config/env.ts'
import type { EntryResult, OrderFill, PriceMap, SellResult } from '../store/store.ts'
import type { PositionDoc } from '../store/store.ts'
import type { ApiOrder, SymbolDetails } from '../gemini/types.ts'
import { GeminiRest } from '../gemini/rest.ts'
import { GeminiPublic } from '../gemini/public.ts'

const ENTRY_WAIT_MS = 90_000
const POLL_MS = 3_000

export class LiveBroker implements Broker {
  readonly name = 'live' as const

  constructor(
    private rest: GeminiRest,
    private pub: GeminiPublic,
    private cfg: AppConfig,
    private detailsOf: (symbol: string) => Promise<SymbolDetails>
  ) {}

  private s(n: number, step: number): string {
    return n.toFixed(decimalsOf(step))
  }

  async usdAvailable(): Promise<number> {
    const bals = await this.rest.balances()
    const usd = bals.find((b) => b.currency === 'USD')
    return usd ? usd.available : 0
  }

  async equity(prices: PriceMap): Promise<number> {
    const bals = await this.rest.balances()
    let total = 0
    for (const b of bals) {
      if (b.currency === 'USD') total += b.available
      else {
        const sym = b.currency.toLowerCase() + 'usd'
        const p = prices[sym]
        if (p && Number.isFinite(p)) total += b.available * p
      }
    }
    return total
  }

  async placeEntry(symbol: string, qty: number, priceHint: number, step: number, quoteIncrement: number): Promise<EntryResult> {
    const price = floorToStep(priceHint, quoteIncrement)
    const order = await this.rest.newOrder({
      symbol,
      amount: this.s(qty, step),
      price: this.s(price, quoteIncrement),
      side: 'buy',
      type: 'exchange limit',
      options: ['maker-or-cancel'],
      clientOrderId: 'e-' + Date.now()
    })
    const deadline = Date.now() + ENTRY_WAIT_MS
    let last: ApiOrder = order
    while (Date.now() < deadline) {
      last = await this.rest.orderStatus(order.id)
      if (!last.isLive || Number(last.remainingAmount) <= 0) break
      await sleepMs(POLL_MS)
    }
    if (last.isLive && Number(last.remainingAmount) > 0) {
      await this.rest.cancelOrder(order.id).catch(() => undefined)
      last = await this.rest.orderStatus(order.id)
    }
    const executed = Number(last.executedAmount)
    const avg = Number(last.avgExecutionPrice) || price
    if (executed < step) {
      return { ok: false, reason: 'entry order unfilled or below step', qty: 0, avgPrice: 0, entryFeeUsd: 0 }
    }
    const feeEstimate = (executed * avg * this.cfg.makerBps) / 10000
    log.info('LIVE fill buy ' + symbol + ' qty ' + executed + ' @ ' + avg + ' (maker, fee est ' + feeEstimate.toFixed(2) + ')')
    return { ok: true, qty: executed, avgPrice: avg, entryFeeUsd: feeEstimate }
  }

  async placeStop(symbol: string, qty: number, stopPrice: number, refPrice: number, step: number, quoteIncrement: number): Promise<{ orderId: string } | undefined> {
    const sellPrice = floorToStep(stopPrice * 0.999, quoteIncrement)
    const order = await this.rest.newOrder({
      symbol,
      amount: this.s(qty, step),
      price: this.s(sellPrice, quoteIncrement),
      side: 'sell',
      type: 'exchange stop-limit',
      stopPrice: this.s(stopPrice, quoteIncrement)
    })
    return { orderId: String(order.id) }
  }

  async placeTarget(symbol: string, qty: number, targetPrice: number, step: number, quoteIncrement: number): Promise<{ orderId: string } | undefined> {
    const price = climbToStep(targetPrice, quoteIncrement)
    const order = await this.rest.newOrder({
      symbol,
      amount: this.s(qty, step),
      price: this.s(price, quoteIncrement),
      side: 'sell',
      type: 'exchange limit',
      options: ['maker-or-cancel']
    })
    return { orderId: String(order.id) }
  }

  async pollFills(pos: PositionDoc, _price: number): Promise<OrderFill[]> {
    const fills: OrderFill[] = []
    const check = async (orderId: string | null, kind: 'stop' | 'target'): Promise<void> => {
      if (!orderId) return
      try {
        const o = await this.rest.orderStatus(orderId)
        const executed = Number(o.executedAmount)
        if (executed > 0 && (!o.isLive || Number(o.remainingAmount) <= 0)) {
          const avg = Number(o.avgExecutionPrice) || pos.stop
          const notional = executed * avg
          const fee = (notional * (kind === 'stop' ? this.cfg.takerBps : this.cfg.makerBps)) / 10000
          fills.push({ kind, orderId: orderId, qty: executed, price: avg, feeUsd: fee })
        }
      } catch (e) {
        log.warn('pollFills status failed for ' + orderId + ': ' + String((e as Error).message))
      }
    }
    await check(pos.stopOrderId, 'stop')
    await check(pos.targetOrderId, 'target')
    return fills
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (!orderId) return
    try {
      await this.rest.cancelOrder(orderId)
    } catch (e) {
      // already gone is fine; anything else is logged but not fatal
      log.warn('cancel ' + orderId + ': ' + String((e as Error).message))
    }
  }

  async cancelAllFor(symbol: string): Promise<void> {
    await this.rest.cancelAll(symbol)
  }

  async sellNow(symbol: string, qty: number, refPrice: number, step: number, quoteIncrement: number): Promise<SellResult | undefined> {
    for (const discount of [0.003, 0.006, 0.012]) {
      const price = floorToStep(refPrice * (1 - discount), quoteIncrement)
      try {
        const o = await this.rest.newOrder({
          symbol,
          amount: this.s(qty, step),
          price: this.s(price, quoteIncrement),
          side: 'sell',
          type: 'exchange limit',
          options: ['immediate-or-cancel']
        })
        const status = await this.rest.orderStatus(o.id)
        const executed = Number(status.executedAmount)
        if (executed >= step) {
          const avg = Number(status.avgExecutionPrice) || price
          const fee = (executed * avg * this.cfg.takerBps) / 10000
          return { ok: true, qty: executed, avgPrice: avg, feeUsd: fee }
        }
      } catch (e) {
        log.warn('sellNow attempt failed on ' + symbol + ': ' + String((e as Error).message))
      }
    }
    return undefined
  }

  async details(symbol: string): Promise<SymbolDetails> {
    return this.detailsOf(symbol)
  }
}
