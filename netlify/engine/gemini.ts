// Gemini market-data + private-REST clients for the serverless engine.
// Public endpoints are plain fetches; private calls carry the same
// HMAC-SHA384 triple-header signing as the standalone backend
// (X-GEMINI-APIKEY / X-GEMINI-PAYLOAD / X-GEMINI-SIGNATURE), ported from
// backend/src/gemini/rest.ts. Nonces are millisecond timestamps, strictly
// increasing per invocation, which is always above Gemini's floor.

import { createHmac } from 'node:crypto'
import { CONFIG } from './config.ts'
import type { Candle, OrderBook, SymbolDetails, Ticker, ApiBalance, ApiOrder } from '../../backend/src/gemini/types.ts'
import type { GeminiCreds } from './blobs.ts'
import type { ServerlessState } from './state.ts'

// ---------------- public ----------------

async function pubGet<T>(path: string): Promise<T> {
  const res = await fetch(CONFIG.publicBaseUrl + path, {
    method: 'GET',
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(8000)
  })
  if (!res.ok) throw new Error('Gemini public ' + path + ' failed ' + res.status + ': ' + (await res.text()).slice(0, 200))
  return JSON.parse(await res.text()) as T
}

export async function ticker(symbol: string): Promise<Ticker> {
  const t = await pubGet<{ last: string, bid: string, ask: string, volume: Record<string, string> }>('/v1/pubticker/' + symbol)
  return {
    symbol,
    last: Number(t.last),
    bid: Number(t.bid),
    ask: Number(t.ask),
    volume24h: Number(t.volume === undefined ? 0 : t.volume[symbol.toUpperCase()] ?? 0)
  }
}

export async function book(symbol: string, depth = 20): Promise<OrderBook> {
  const b = await pubGet<{ bids: Array<{ price: string, amount: string }>, asks: Array<{ price: string, amount: string }> }>(
    '/v1/book/' + symbol + '?limit_bids=' + depth + '&limit_asks=' + depth
  )
  return {
    bids: (b.bids ?? []).map((l) => ({ price: Number(l.price), amount: Number(l.amount) })).sort((x, y) => y.price - x.price),
    asks: (b.asks ?? []).map((l) => ({ price: Number(l.price), amount: Number(l.amount) })).sort((x, y) => x.price - y.price)
  }
}

export async function candles(symbol: string, frame: string): Promise<Candle[]> {
  const raw = await pubGet<unknown>('/v2/candles/' + symbol + '/' + frame)
  let rows: unknown = raw
  if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0]) && Array.isArray((raw[0] as unknown[])[0])) {
    rows = raw[0]
  }
  const out: Candle[] = []
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(r) || r.length < 6) continue
    const c: Candle = { t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) }
    if ([c.t, c.o, c.h, c.l, c.c, c.v].every((n) => Number.isFinite(n))) out.push(c)
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

// details cache lives in the invocation only; the tick fetches at most a
// handful of symbols, and each function instance is short-lived.
const detailsCache = new Map<string, { at: number, details: SymbolDetails }>()

export async function details(symbol: string): Promise<SymbolDetails> {
  const hit = detailsCache.get(symbol)
  if (hit && Date.now() - hit.at < 12 * 3600 * 1000) return hit.details
  const d = await pubGet<{
    symbol: string, base_currency: string, quote_currency: string,
    tick_size: string, quote_increment: string,
    min_order_size: string, min_order_size_quote?: string
  }>('/v1/symbols/' + symbol + '/details')
  const det: SymbolDetails = {
    symbol: d.symbol,
    baseCurrency: d.base_currency,
    quoteCurrency: d.quote_currency,
    tickSize: Number(d.tick_size),
    quoteIncrement: Number(d.quote_increment),
    minOrderSize: Number(d.min_order_size),
    minOrderSizeQuote: Number(d.min_order_size_quote ?? '5')
  }
  detailsCache.set(symbol, { at: Date.now(), details: det })
  return det
}

// ---------------- private (signed) ----------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let lastNonce = 0

function nextNonce(): number {
  const n = Date.now()
  lastNonce = Math.max(lastNonce + 1, n)
  return lastNonce
}

export interface NewOrderParams {
  symbol: string
  amount: string
  price: string
  side: 'buy' | 'sell'
  type?: 'exchange limit' | 'exchange stop-limit'
  stopPrice?: string
  clientOrderId?: string
  options?: string[]
}

export async function signedPost<T>(creds: GeminiCreds, path: string, params: Record<string, unknown>): Promise<T> {
  const payload: Record<string, unknown> = { request: path, nonce: nextNonce(), ...params }
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  const sig = createHmac('sha384', creds.secret).update(b64).digest('hex')
  const headers = {
    'Content-Type': 'text/plain',
    'Content-Length': String(b64.length),
    'X-GEMINI-APIKEY': creds.key,
    'X-GEMINI-PAYLOAD': b64,
    'X-GEMINI-SIGNATURE': sig,
    'Cache-Control': 'no-cache'
  }
  let attempt = 0
  while (true) {
    attempt++
    let res: Response
    try {
      res = await fetch(CONFIG.privateBaseUrl + path, { method: 'POST', headers, body: b64, signal: AbortSignal.timeout(9000) })
    } catch (e) {
      if (attempt >= 3) throw new Error('Gemini request network failure: ' + String((e as Error).message))
      await sleep(400 * attempt)
      continue
    }
    const text = await res.text()
    if (res.status === 429) {
      if (attempt >= 4) throw new Error('Gemini rate limited on ' + path)
      await sleep(Number(res.headers.get('retry-after-ms')) || 2000)
      continue
    }
    if (res.status === 400 && text.includes('InvalidNonce')) {
      if (attempt >= 2) throw new Error('Gemini nonce rejected on ' + path)
      continue // re-sign with a bumped nonce on the next loop iteration
    }
    if (res.status === 502 || res.status === 503) {
      if (attempt >= 2) throw new Error('Gemini ' + res.status + ' on ' + path)
      await sleep(500)
      continue
    }
    if (!res.ok) throw new Error('Gemini API error ' + res.status + ' on ' + path + ': ' + text.slice(0, 250))
    return JSON.parse(text) as T
  }
}

export async function balances(creds: GeminiCreds): Promise<ApiBalance[]> {
  const raw = await signedPost<Array<{ currency: string, available: string, balance: string }>>(creds, '/v1/balances', {})
  return raw.map((b) => ({ currency: b.currency, available: Number(b.available), balance: Number(b.balance) }))
}

export async function newOrder(creds: GeminiCreds, o: NewOrderParams): Promise<ApiOrder> {
  const params: Record<string, unknown> = {
    symbol: o.symbol,
    amount: o.amount,
    price: o.price,
    side: o.side,
    type: o.type ?? 'exchange limit',
    options: o.options ?? []
  }
  if (o.stopPrice !== undefined) params.stop_price = o.stopPrice
  if (o.clientOrderId !== undefined) params.client_order_id = o.clientOrderId.replace(/[^a-zA-Z0-9_-]/g, 'x').slice(0, 100)
  return signedPost<ApiOrder>(creds, '/v1/order/new', params)
}

export async function orderStatus(creds: GeminiCreds, orderId: string | number): Promise<ApiOrder> {
  return signedPost<ApiOrder>(creds, '/v1/order/status', { order_id: orderId })
}

export async function cancelOrder(creds: GeminiCreds, orderId: string | number): Promise<ApiOrder> {
  return signedPost<ApiOrder>(creds, '/v1/order/cancel', { order_id: orderId })
}

export async function cancelAllFor(creds: GeminiCreds | undefined, symbol: string): Promise<void> {
  if (!creds) return
  try {
    await signedPost(creds, '/v1/order/cancel/all', { symbol })
  } catch {
    // already-empty book or transient error: not fatal
  }
}

// price helpers on the state (the tick refreshes state.prices from tickers)

export function priceOf(st: ServerlessState, symbol: string): number | undefined {
  const t = st.prices[symbol]
  return t ? t.price : undefined
}
