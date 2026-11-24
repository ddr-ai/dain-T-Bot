// Broker interface shared by paper and live implementations, plus order
// chunking: entries above ORDER_CHUNK_THRESHOLD_USD are sliced into 2-3
// child orders spaced 30 seconds apart to avoid moving the book.

import type { EntryResult, OrderFill, PriceMap, SellResult } from '../store/store.ts'
import type { PositionDoc } from '../store/store.ts'

export interface Broker {
  readonly name: 'paper' | 'live'

  usdAvailable(): Promise<number>
  equity(prices: PriceMap): Promise<number>

  // Maker-style entry at priceHint (top of bid). Resolves when filled
  // (fully or partially), cancelled, or timed out per tranche.
  placeEntry(symbol: string, qty: number, priceHint: number, step: number, quoteIncrement: number): Promise<EntryResult>

  placeStop(symbol: string, qty: number, stopPrice: number, refPrice: number, step: number, quoteIncrement: number): Promise<{ orderId: string } | undefined>
  placeTarget(symbol: string, qty: number, targetPrice: number, step: number, quoteIncrement: number): Promise<{ orderId: string } | undefined>

  // Inspect resting stop/target orders against current prices and report fills.
  pollFills(pos: PositionDoc, price: number): Promise<OrderFill[]>

  cancelOrder(orderId: string): Promise<void>
  cancelAllFor(symbol: string): Promise<void>

  // Emergency/time-exit sell near the market.
  sellNow(symbol: string, qty: number, refPrice: number, step: number, quoteIncrement: number): Promise<SellResult | undefined>
}

// Slice a planned entry into 2-3 tranches when the notional is large.
export function chunkQty(qty: number, price: number, thresholdUsd: number, step: number): number[] {
  const notional = qty * price
  if (thresholdUsd <= 0 || notional <= thresholdUsd || qty <= step) return [qty]
  const parts = notional > thresholdUsd * 3 ? 3 : 2
  const out: number[] = []
  const each = qty / parts
  let remaining = qty
  for (let i = 0; i < parts; i++) {
    let q = each
    if (i === parts - 1) q = remaining
    q = Math.floor(q / step + 1e-9) * step
    if (q >= step) out.push(q)
    remaining -= q
  }
  if (out.length === 0) out.push(Math.floor(qty / step) * step)
  return out
}
