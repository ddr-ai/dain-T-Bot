// Brokers for the serverless engine: PAPER simulates fills against the live
// public price feed exactly like the standalone PaperBroker; LIVE executes
// through the Gemini private REST API. Because a serverless invocation is
// short-lived, the live ENTRY is an immediate-or-cancel taker buy that pays
// the ask (no maker-or-cancel polling loop); stops and targets are the same
// exchange-resting orders as the standalone engine, so position protection
// is IDENTICAL and keeps working between ticks on Gemini's servers.

import { climbToStep, decimalsOf, floorToStep } from '../../backend/src/util/round.ts'
import { CONFIG } from './config.ts'
import type { ServerlessState, PositionDoc } from './state.ts'
import { addActivity } from './state.ts'
import type { GeminiCreds } from './blobs.ts'
import { newOrder, orderStatus, cancelOrder, cancelAllFor, priceOf } from './gemini.ts'

export interface EntryResult {
  ok: boolean
  reason?: string
  qty: number
  avgPrice: number
  entryFeeUsd: number
}

export interface SellResult {
  ok: boolean
  qty: number
  avgPrice: number
  feeUsd: number
}

export interface OrderFill {
  kind: 'stop' | 'target'
  orderId: string
  qty: number
  price: number
  feeUsd: number
}

// ---------------------- paper broker ----------------------

const paperOrdersOf = (st: ServerlessState, symbol: string) => {
  if (!st.paperOrders[symbol]) st.paperOrders[symbol] = []
  return st.paperOrders[symbol]
}

function paperRemoveKind(st: ServerlessState, symbol: string, kind: 'stop' | 'target'): void {
  st.paperOrders[symbol] = paperOrdersOf(st, symbol).filter((o) => o.kind !== kind)
}

export function paperEquity(st: ServerlessState): number {
  let total = st.paperBalances.usd
  for (const [sym, qty] of Object.entries(st.paperBalances.coins)) {
    const p = priceOf(st, sym)
    if (p && Number.isFinite(p)) total += qty * p
  }
  return total
}

export function paperEntry(st: ServerlessState, symbol: string, qty: number, priceHint: number, step: number): EntryResult {
  const price = priceHint * (1 - CONFIG.slipBps / 10000) // slight maker improvement
  const cost = qty * price
  const fee = (cost * CONFIG.makerBps) / 10000
  if (cost + fee > st.paperBalances.usd + 1e-9) {
    return { ok: false, reason: 'paper: insufficient USD (cost ' + cost.toFixed(2) + ')', qty: 0, avgPrice: 0, entryFeeUsd: 0 }
  }
  st.paperBalances.usd -= cost + fee
  st.paperBalances.coins[symbol] = (st.paperBalances.coins[symbol] ?? 0) + qty
  addActivity(st, 'paper', 'PAPER fill buy ' + symbol + ' qty ' + qty + ' @ ' + price.toFixed(2) + ' fee ' + fee.toFixed(2), symbol)
  return { ok: true, qty, avgPrice: price, entryFeeUsd: fee }
}

export function paperPlaceStop(st: ServerlessState, symbol: string, qty: number, stopPrice: number): string {
  const id = 'pst-' + Date.now().toString(36) + '-' + st.seq
  paperOrdersOf(st, symbol).push({ id, kind: 'stop', qty, price: stopPrice })
  return id
}

export function paperPlaceTarget(st: ServerlessState, symbol: string, qty: number, targetPrice: number): string {
  const id = 'ptg-' + Date.now().toString(36) + '-' + st.seq
  paperOrdersOf(st, symbol).push({ id, kind: 'target', qty, price: targetPrice })
  return id
}

export function paperPollFills(st: ServerlessState, pos: PositionDoc, price: number): OrderFill[] {
  const fills: OrderFill[] = []
  for (const o of paperOrdersOf(st, pos.symbol)) {
    const hitStop = o.kind === 'stop' && price <= o.price
    const hitTarget = o.kind === 'target' && price >= o.price
    if (!hitStop && !hitTarget) continue
    const held = st.paperBalances.coins[pos.symbol] ?? 0
    if (held + 1e-9 < o.qty) continue
    const exitPrice = hitStop ? o.price * (1 - CONFIG.slipBps / 10000) : o.price
    const bps = hitStop ? CONFIG.takerBps : CONFIG.makerBps
    const notional = o.qty * exitPrice
    const fee = (notional * bps) / 10000
    st.paperBalances.coins[pos.symbol] = held - o.qty
    if (Math.abs(st.paperBalances.coins[pos.symbol] ?? 0) < 1e-12) delete st.paperBalances.coins[pos.symbol]
    st.paperBalances.usd += notional - fee
    fills.push({ kind: o.kind, orderId: o.id, qty: o.qty, price: exitPrice, feeUsd: fee })
  }
  if (fills.length > 0) {
    // OCO emulation: once one side fills, both resting orders go away.
    paperRemoveKind(st, pos.symbol, 'stop')
    paperRemoveKind(st, pos.symbol, 'target')
  }
  return fills
}

export function paperCancelOrder(st: ServerlessState, symbol: string, orderId: string): void {
  st.paperOrders[symbol] = paperOrdersOf(st, symbol).filter((o) => o.id !== orderId)
}

export function paperCancelAll(st: ServerlessState, symbol: string): void {
  st.paperOrders[symbol] = []
}

export function paperSellNow(st: ServerlessState, symbol: string, qty: number, refPrice: number, step: number): SellResult | undefined {
  const held = st.paperBalances.coins[symbol] ?? 0
  const q = Math.min(qty, Math.max(0, held))
  if (q < step || q <= 0) return undefined
  const price = refPrice * (1 - CONFIG.slipBps / 10000)
  const notional = q * price
  const fee = (notional * CONFIG.takerBps) / 10000
  st.paperBalances.coins[symbol] = held - q
  st.paperBalances.usd += notional - fee
  return { ok: true, qty: q, avgPrice: price, feeUsd: fee }
}

// ---------------------- live broker ----------------------

const s = (n: number, step: number): string => n.toFixed(decimalsOf(step))

export async function liveUsdAvailable(creds: GeminiCreds): Promise<number> {
  const bals = await import('./gemini.ts').then((m) => m.balances(creds))
  const usd = bals.find((b) => b.currency === 'USD')
  return usd ? usd.available : 0
}

export async function liveEquity(st: ServerlessState, creds: GeminiCreds): Promise<number> {
  const bals = await import('./gemini.ts').then((m) => m.balances(creds))
  let total = 0
  for (const b of bals) {
    if (b.currency === 'USD') total += b.available
    else {
      const p = priceOf(st, b.currency.toLowerCase() + 'usd')
      if (p && Number.isFinite(p)) total += b.available * p
    }
  }
  return total
}

// IOC taker buy through the top of the ask. Returns the FILLED quantity, so
// an entry can never leave a dangling unfilled order behind.
export async function liveEntry(creds: GeminiCreds, symbol: string, qty: number, ask: number, step: number, quoteIncrement: number): Promise<EntryResult> {
  const price = climbToStep(ask * 1.001, quoteIncrement) // cross the spread
  const order = await newOrder(creds, {
    symbol,
    amount: s(qty, step),
    price: s(price, quoteIncrement),
    side: 'buy',
    type: 'exchange limit',
    options: ['immediate-or-cancel'],
    clientOrderId: 'e-' + Date.now()
  })
  let last = order
  try {
    last = await orderStatus(creds, order.id)
  } catch {
    // the new-order response already carries execution info on IOC fills
  }
  const executed = Number(last.executedAmount)
  const avg = Number(last.avgExecutionPrice) || price
  if (executed < step) {
    return { ok: false, reason: 'entry IOC unfilled', qty: 0, avgPrice: 0, entryFeeUsd: 0 }
  }
  const feeEstimate = (executed * avg * CONFIG.takerBps) / 10000
  return { ok: true, qty: executed, avgPrice: avg, entryFeeUsd: feeEstimate }
}

export async function livePlaceStop(creds: GeminiCreds, symbol: string, qty: number, stopPrice: number, step: number, quoteIncrement: number): Promise<string> {
  const sellPrice = floorToStep(stopPrice * 0.999, quoteIncrement)
  const order = await newOrder(creds, {
    symbol,
    amount: s(qty, step),
    price: s(sellPrice, quoteIncrement),
    side: 'sell',
    type: 'exchange stop-limit',
    stopPrice: s(stopPrice, quoteIncrement)
  })
  return String(order.id)
}

export async function livePlaceTarget(creds: GeminiCreds, symbol: string, qty: number, targetPrice: number, step: number, quoteIncrement: number): Promise<string> {
  const price = climbToStep(targetPrice, quoteIncrement)
  const order = await newOrder(creds, {
    symbol,
    amount: s(qty, step),
    price: s(price, quoteIncrement),
    side: 'sell',
    type: 'exchange limit',
    options: ['maker-or-cancel']
  })
  return String(order.id)
}

export async function livePollFills(creds: GeminiCreds, pos: PositionDoc): Promise<OrderFill[]> {
  const fills: OrderFill[] = []
  const check = async (orderId: string | null, kind: 'stop' | 'target'): Promise<void> => {
    if (!orderId) return
    try {
      const o = await orderStatus(creds, orderId)
      const executed = Number(o.executedAmount)
      if (executed > 0 && (!o.isLive || Number(o.remainingAmount) <= 0)) {
        const avg = Number(o.avgExecutionPrice) || (kind === 'stop' ? pos.stop : pos.target)
        const notional = executed * avg
        const fee = (notional * (kind === 'stop' ? CONFIG.takerBps : CONFIG.makerBps)) / 10000
        fills.push({ kind, orderId, qty: executed, price: avg, feeUsd: fee })
      }
    } catch {
      // order status hiccup: try again next tick
    }
  }
  await check(pos.stopOrderId, 'stop')
  await check(pos.targetOrderId, 'target')
  return fills
}

export async function liveSellNow(creds: GeminiCreds, symbol: string, qty: number, refPrice: number, step: number, quoteIncrement: number): Promise<SellResult | undefined> {
  for (const discount of [0.003, 0.006, 0.012]) {
    const price = floorToStep(refPrice * (1 - discount), quoteIncrement)
    try {
      const o = await newOrder(creds, {
        symbol,
        amount: s(qty, step),
        price: s(price, quoteIncrement),
        side: 'sell',
        type: 'exchange limit',
        options: ['immediate-or-cancel']
      })
      const status = await orderStatus(creds, o.id)
      const executed = Number(status.executedAmount)
      if (executed >= step) {
        const avg = Number(status.avgExecutionPrice) || price
        const fee = (executed * avg * CONFIG.takerBps) / 10000
        return { ok: true, qty: executed, avgPrice: avg, feeUsd: fee }
      }
    } catch {
      // try the next, deeper discount tranche
    }
  }
  return undefined
}

export async function cancelLiveOrder(creds: GeminiCreds, orderId: string): Promise<void> {
  if (!orderId) return
  try {
    await cancelOrder(creds, orderId)
  } catch {
    // already gone is fine
  }
}

export { cancelAllFor }
