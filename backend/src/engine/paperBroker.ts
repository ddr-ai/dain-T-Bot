// Paper broker: simulates fills locally against the live public price feed.
// Entry fills as a maker at the touched bid, stops fill as taker through the
// stop price (with slippage), targets fill as maker at the limit price.
// Balances live in the JSON state store, so a restart keeps the paper account.

import { randomUUID } from 'node:crypto'
import { log } from '../util/logger.ts'
import { decimalsOf, fmtQty } from '../util/round.ts'
import type { Broker } from './broker.ts'
import type { AppConfig } from '../config/env.ts'
import type { EntryResult, OrderFill, PriceMap, SellResult } from '../store/store.ts'
import type { PositionDoc, Store } from '../store/store.ts'
import type { SymbolDetails } from '../gemini/types.ts'

export class PaperBroker implements Broker {
  readonly name = 'paper' as const

  // Simulated resting orders keyed by id.
  private orders = new Map<string, { symbol: string, kind: 'stop' | 'target', qty: number, price: number }>()

  constructor(
    private store: Store,
    private cfg: AppConfig,
    private priceFn: (symbol: string) => number | undefined
  ) {}

  private usd(): number {
    return this.store.state.paperBalances.usd
  }

  private coins(sym: string): number {
    return this.store.state.paperBalances.coins[sym] ?? 0
  }

  private addUsd(v: number): void {
    this.store.state.paperBalances.usd += v
  }

  private addCoin(sym: string, v: number): void {
    const cur = this.store.state.paperBalances.coins[sym] ?? 0
    const next = cur + v
    if (Math.abs(next) < 1e-12) delete this.store.state.paperBalances.coins[sym]
    else this.store.state.paperBalances.coins[sym] = next
    if (next < -1e-9) log.error('PAPER: negative coin balance for ' + sym + ' - guard violation')
  }

  async usdAvailable(): Promise<number> {
    return this.usd()
  }

  async equity(prices: PriceMap): Promise<number> {
    let total = this.usd()
    for (const [sym, qty] of Object.entries(this.store.state.paperBalances.coins)) {
      const p = prices[sym]
      if (p && Number.isFinite(p)) total += qty * p
    }
    return total
  }

  async placeEntry(symbol: string, qty: number, priceHint: number, step: number): Promise<EntryResult> {
    const price = priceHint * (1 - this.cfg.slipBps / 10000) // slight maker improvement
    const cost = qty * price
    const fee = (cost * this.cfg.makerBps) / 10000
    if (cost + fee > this.usd() + 1e-9) {
      return { ok: false, reason: 'paper: insufficient USD (cost ' + cost.toFixed(2) + ')', qty: 0, avgPrice: 0, entryFeeUsd: 0 }
    }
    this.addUsd(-(cost + fee))
    this.addCoin(symbol, qty)
    this.store.saveSoon()
    log.info('PAPER fill buy ' + symbol + ' qty ' + fmtQty(qty, step) + ' @ ' + price.toFixed(2) + ' fee ' + fee.toFixed(2))
    return { ok: true, qty, avgPrice: price, entryFeeUsd: fee }
  }

  async placeStop(symbol: string, qty: number, stopPrice: number, refPrice: number, step: number): Promise<{ orderId: string } | undefined> {
    const id = randomUUID()
    this.orders.set(id, { symbol, kind: 'stop', qty, price: stopPrice })
    return { orderId: id }
  }

  async placeTarget(symbol: string, qty: number, targetPrice: number, step: number): Promise<{ orderId: string } | undefined> {
    const id = randomUUID()
    this.orders.set(id, { symbol, kind: 'target', qty, price: targetPrice })
    return { orderId: id }
  }

  async pollFills(pos: PositionDoc, price: number): Promise<OrderFill[]> {
    const fills: OrderFill[] = []
    for (const [id, o] of this.orders) {
      if (o.symbol !== pos.symbol) continue
      const hitStop = o.kind === 'stop' && price <= o.price
      const hitTarget = o.kind === 'target' && price >= o.price
      if (!hitStop && !hitTarget) continue
      const held = this.coins(pos.symbol)
      if (held + 1e-9 < o.qty) continue
      const exitPrice = hitStop ? o.price * (1 - this.cfg.slipBps / 10000) : o.price
      const bps = hitStop ? this.cfg.takerBps : this.cfg.makerBps
      const notional = o.qty * exitPrice
      const fee = (notional * bps) / 10000
      this.addCoin(pos.symbol, -o.qty)
      this.addUsd(notional - fee)
      fills.push({ kind: o.kind, orderId: id, qty: o.qty, price: exitPrice, feeUsd: fee })
    }
    if (fills.length > 0) {
      // OCO emulation: once one side fills, both resting orders go away.
      this.removeOrdersFor(pos, 'stop')
      this.removeOrdersFor(pos, 'target')
      this.store.saveSoon()
    }
    return fills
  }

  private removeOrdersFor(pos: PositionDoc, kind: 'stop' | 'target'): void {
    const kill: string[] = []
    for (const [id, o] of this.orders) {
      if (o.symbol === pos.symbol && o.kind === kind) kill.push(id)
    }
    for (const id of kill) this.orders.delete(id)
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.orders.delete(orderId)
  }

  async cancelAllFor(symbol: string): Promise<void> {
    const kill: string[] = []
    for (const [id, o] of this.orders) {
      if (o.symbol === symbol) kill.push(id)
    }
    for (const id of kill) this.orders.delete(id)
  }

  async sellNow(symbol: string, qty: number, refPrice: number, step: number): Promise<SellResult | undefined> {
    const held = this.coins(symbol)
    const q = Math.min(qty, Math.max(0, held))
    if (q < step || q <= 0) return undefined
    const price = refPrice * (1 - this.cfg.slipBps / 10000)
    const notional = q * price
    const fee = (notional * this.cfg.takerBps) / 10000
    this.addCoin(symbol, -q)
    this.addUsd(notional - fee)
    this.store.saveSoon()
    return { ok: true, qty: q, avgPrice: price, feeUsd: fee }
  }

  // Expose details-like step info so callers do not need the network in tests.
  static fallbackDetails(): SymbolDetails {
    return {
      symbol: 'paper', baseCurrency: 'X', quoteCurrency: 'USD',
      tickSize: 1e-8, quoteIncrement: 0.01, minOrderSize: 1e-8, minOrderSizeQuote: 5
    }
  }

  stepDecimalsOf(): number {
    return decimalsOf(1e-8)
  }
}
