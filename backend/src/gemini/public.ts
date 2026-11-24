// Public (unauthenticated) Gemini endpoints used for market data.
// Strategy candles come from API v2, tickers/order books from v1.

import { log } from '../util/logger.ts'
import type { Candle, OrderBook, SymbolDetails, Ticker } from './types.ts'

export class GeminiPublic {
  private detailsCache = new Map<string, { at: number, details: SymbolDetails }>()
  private readonly cacheMs = 12 * 3600 * 1000

  constructor(private baseUrl: string) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(this.baseUrl + path, { method: 'GET', headers: { 'Cache-Control': 'no-cache' } })
    const text = await res.text()
    if (!res.ok) throw new Error('Gemini public ' + path + ' failed ' + res.status + ': ' + text.slice(0, 200))
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error('Gemini public ' + path + ' returned invalid JSON')
    }
  }

  async symbols(): Promise<string[]> {
    return this.get<string[]>('/v1/symbols')
  }

  async ticker(symbol: string): Promise<Ticker> {
    const t = await this.get<{ last: string, bid: string, ask: string, volume: Record<string, string> }>(
      '/v1/pubticker/' + symbol
    )
    return {
      symbol,
      last: Number(t.last),
      bid: Number(t.bid),
      ask: Number(t.ask),
      volume24h: Number(t.volume === undefined ? 0 : t.volume[symbol.toUpperCase()] ?? 0)
    }
  }

  async book(symbol: string, depth = 20): Promise<OrderBook> {
    const b = await this.get<{ bids: Array<{ price: string, amount: string }>, asks: Array<{ price: string, amount: string }> }>(
      '/v1/book/' + symbol + '?limit_bids=' + depth + '&limit_asks=' + depth
    )
    return {
      bids: (b.bids ?? []).map((l) => ({ price: Number(l.price), amount: Number(l.amount) })).sort((x, y) => y.price - x.price),
      asks: (b.asks ?? []).map((l) => ({ price: Number(l.price), amount: Number(l.amount) })).sort((x, y) => x.price - y.price)
    }
  }

  // v2 candles: [[time_ms, open, high, low, close, volume], ...] oldest first.
  // frame: '1m' '5m' '15m' '30m' '1hr' '4hr' '6hr' '1day' '1w' '1mo'
  async candles(symbol: string, frame: string): Promise<Candle[]> {
    const raw = await this.get<unknown>('/v2/candles/' + symbol + '/' + frame)
    let rows: unknown = raw
    // Some deployments wrap the array once; detect and unwrap.
    if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0]) && Array.isArray((raw[0] as unknown[])[0])) {
      rows = raw[0]
    }
    return this.normalize(rows)
  }

  private normalize(rows: unknown): Candle[] {
    if (!Array.isArray(rows)) {
      log.warn('Unexpected candles payload shape')
      return []
    }
    const out: Candle[] = []
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 6) continue
      const c: Candle = {
        t: Number(r[0]),
        o: Number(r[1]),
        h: Number(r[2]),
        l: Number(r[3]),
        c: Number(r[4]),
        v: Number(r[5])
      }
      if ([c.t, c.o, c.h, c.l, c.c, c.v].every((n) => Number.isFinite(n))) out.push(c)
    }
    out.sort((a, b) => a.t - b.t)
    const dedup: Candle[] = []
    for (const c of out) {
      if (dedup.length === 0 || dedup[dedup.length - 1].t !== c.t) dedup.push(c)
    }
    return dedup
  }

  async details(symbol: string): Promise<SymbolDetails> {
    const hit = this.detailsCache.get(symbol)
    if (hit && Date.now() - hit.at < this.cacheMs) return hit.details
    const d = await this.get<{
      symbol: string, base_currency: string, quote_currency: string,
      tick_size: string, quote_increment: string,
      min_order_size: string, min_order_size_quote?: string
    }>('/v1/symbols/' + symbol + '/details')
    const details: SymbolDetails = {
      symbol: d.symbol,
      baseCurrency: d.base_currency,
      quoteCurrency: d.quote_currency,
      tickSize: Number(d.tick_size),
      quoteIncrement: Number(d.quote_increment),
      minOrderSize: Number(d.min_order_size),
      minOrderSizeQuote: Number(d.min_order_size_quote ?? '5')
    }
    this.detailsCache.set(symbol, { at: Date.now(), details })
    return details
  }
}
