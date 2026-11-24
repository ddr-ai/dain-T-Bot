// Gemini private REST client with HMAC-SHA384 request signing.
// Every private endpoint is POST and carries three headers:
//   X-GEMINI-APIKEY, X-GEMINI-PAYLOAD (base64 JSON), X-GEMINI-SIGNATURE (hex HMAC-SHA384).
// The JSON payload body is { request: path, nonce, ...params }.

import { createHmac } from 'node:crypto'
import { Mutex } from '../util/lock.ts'
import { NonceManager } from './nonce.ts'
import { log } from '../util/logger.ts'
import type { ApiBalance, ApiOrder, GeminiCreds } from './types.ts'

export type CredsProvider = () => GeminiCreds | undefined

export class GeminiRestError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super('Gemini API error ' + status + ': ' + body.slice(0, 300))
    this.status = status
    this.body = body
  }
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

export class GeminiRest {
  private requestMutex = new Mutex()
  readonly nonce = new NonceManager()

  constructor(
    private baseUrl: string,
    private credsProvider: CredsProvider
  ) {}

  setCredsProvider(p: CredsProvider): void {
    this.credsProvider = p
  }

  hasCreds(): boolean {
    const c = this.credsProvider()
    return c !== undefined && c.key.length > 0 && c.secret.length > 0
  }

  // Serialize all private calls through one mutex so nonces stay ordered
  // even when the engine fires concurrent requests.
  private async signed<T>(path: string, params: Record<string, unknown>): Promise<T> {
    return this.requestMutex.run(() => this.signedInner<T>(path, params))
  }

  private async signedInner<T>(path: string, params: Record<string, unknown>): Promise<T> {
    const creds = this.credsProvider()
    if (!creds) throw new Error('Gemini credentials are not configured')
    const payload: Record<string, unknown> = {
      request: path,
      nonce: await this.nonce.next(),
      ...params
    }
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
    // retry loop: nonce errors get one bump-retry, 429s back off.
    while (true) {
      attempt++
      let res: Response
      try {
        res = await fetch(this.baseUrl + path, { method: 'POST', headers, body: b64 })
      } catch (e: unknown) {
        if (attempt >= 3) throw new Error('Gemini request network failure: ' + String((e as Error).message))
        await sleep(500 * attempt)
        continue
      }
      const text = await res.text()
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after-ms')) || 2000
        if (attempt >= 4) throw new GeminiRestError(429, text)
        log.warn('Gemini rate limited, backing off ' + retryAfter + 'ms on ' + path)
        await sleep(retryAfter)
        continue
      }
      if (res.status === 400 && text.includes('InvalidNonce')) {
        if (attempt >= 2) throw new GeminiRestError(400, text)
        log.warn('Gemini nonce rejected, bumping and retrying')
        this.nonce.bump()
        continue
      }
      if (res.status === 502 || res.status === 503) {
        if (attempt >= 3) throw new GeminiRestError(res.status, text)
        await sleep(1000 * attempt)
        continue
      }
      if (!res.ok) throw new GeminiRestError(res.status, text)
      return JSON.parse(text) as T
    }
  }

  async balances(): Promise<ApiBalance[]> {
    const raw = await this.signed<Array<{ currency: string; type: string; available: string; balance: string }>>(
      '/v1/balances', {}
    )
    return raw.map((b) => ({
      currency: b.currency,
      available: Number(b.available),
      balance: Number(b.balance)
    }))
  }

  async newOrder(o: NewOrderParams): Promise<ApiOrder> {
    const params: Record<string, unknown> = {
      symbol: o.symbol,
      amount: o.amount,
      price: o.price,
      side: o.side,
      type: o.type ?? 'exchange limit',
      options: o.options ?? []
    }
    if (o.stopPrice !== undefined) params.stop_price = o.stopPrice
    if (o.clientOrderId !== undefined) params.client_order_id = this.clientOrderIdSafe(o.clientOrderId)
    return this.signed<ApiOrder>('/v1/order/new', params)
  }

  async orderStatus(orderId: number | string): Promise<ApiOrder> {
    return this.signed<ApiOrder>('/v1/order/status', { order_id: orderId })
  }

  async cancelOrder(orderId: number | string): Promise<ApiOrder> {
    return this.signed<ApiOrder>('/v1/order/cancel', { order_id: orderId })
  }

  async cancelAll(symbol?: string): Promise<void> {
    const params: Record<string, unknown> = symbol ? { symbol } : {}
    await this.signed('/v1/order/cancel/all', params)
  }

  async activeOrders(symbol?: string): Promise<ApiOrder[]> {
    const params: Record<string, unknown> = {}
    if (symbol) params.symbol = symbol
    const raw = await this.signed<unknown[]>('/v1/orders', params)
    return raw as unknown as ApiOrder[]
  }

  private clientOrderIdSafe(id: string): string {
    // Gemini restricts client order id charset; keep it conservative.
    return id.replace(/[^a-zA-Z0-9_-]/g, 'x').slice(0, 100)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
