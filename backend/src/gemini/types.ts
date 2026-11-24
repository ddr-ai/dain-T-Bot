// Shared types for Gemini API data.

export interface Candle {
  t: number  // ms epoch
  o: number
  h: number
  l: number
  c: number
  v: number
}

export interface Ticker {
  symbol: string
  last: number
  bid: number
  ask: number
  volume24h: number
}

export interface BookLevel {
  price: number
  amount: number
}

export interface OrderBook {
  bids: BookLevel[]
  asks: BookLevel[]
}

export interface SymbolDetails {
  symbol: string
  baseCurrency: string
  quoteCurrency: string
  tickSize: number       // quantity step
  quoteIncrement: number // price step
  minOrderSize: number   // minimum quantity
  minOrderSizeQuote: number // minimum notional in quote currency
}

export interface ApiOrder {
  id: number
  symbol: string
  side: 'buy' | 'sell'
  type: string
  price: number | null
  avgExecutionPrice: number
  executedAmount: number
  originalAmount: number
  remainingAmount: number
  options: string[]
  isLive: boolean
  isCancelled: boolean
  wasForced: boolean
  reason?: string
  stopPrice?: number | null
  clientOrderId?: string
}

export interface ApiBalance {
  currency: string
  available: number
  balance: number
}

export interface GeminiCreds {
  key: string
  secret: string
}
