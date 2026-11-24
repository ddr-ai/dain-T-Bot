// Minimal RFC6455 WebSocket client built on node:tls - zero dependencies.
// Connects to the Gemini market data feed, responds to server pings,
// reconnects with exponential backoff, and tracks tick freshness
// (the stale-price kill switch reads lastTickAt).

import { connect as tlsConnect } from 'node:tls'
import { randomBytes } from 'node:crypto'
import { log } from '../util/logger.ts'

export interface MarketSocketOptions {
  host: string
  symbol: string
  onPrice: (price: number) => void
  onAnyTick?: () => void
  staleMs?: number
}

interface RawFrame {
  opcode: number
  fin: boolean
  payload: Buffer
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

export class MarketSocket {
  private sock: import('node:tls').TLSSocket | undefined
  private buf = Buffer.alloc(0)
  private opened = false
  private stopped = true
  private reconnectDelay = 1000
  private lastTickAt = 0
  private lastPrice = 0
  private fragments: Buffer[] = []
  private reconnectTimer: NodeJS.Timeout | undefined
  private stallTimer: NodeJS.Timeout | undefined

  constructor(private opts: MarketSocketOptions) {}

  get symbol(): string { return this.opts.symbol }
  get price(): number { return this.lastPrice }
  get lastTickTimestamp(): number { return this.lastTickAt }
  get stale(): boolean {
    return this.lastTickAt === 0 || Date.now() - this.lastTickAt > (this.opts.staleMs ?? 60000)
  }

  start(): void {
    this.stopped = false
    this.connect()
    // Heartbeat watchdog: even with heartbeat=true, ensure we see bytes.
    this.stallTimer = setInterval(() => {
      if (this.stopped) return
      if (this.opened && this.stale) {
        log.warn('WS ' + this.opts.symbol + ': no ticks, treating socket as dead')
        this.destroySocket()
      }
    }, 15000)
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.stallTimer) clearInterval(this.stallTimer)
    this.destroySocket()
  }

  private destroySocket(): void {
    this.opened = false
    if (this.sock) {
      try { this.sock.destroy() } catch { /* ignore */ }
      this.sock = undefined
    }
    if (!this.stopped) this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.stopped) this.connect()
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000)
  }

  private connect(): void {
    const host = this.opts.host
    let headerBuf = Buffer.alloc(0)
    let handshakeDone = false

    const sock = tlsConnect({ host, port: 443, servername: host, rejectUnauthorized: true })
    this.sock = sock

    sock.on('secureConnect', () => {
      const key = randomBytes(16).toString('base64')
      const path = '/v1/marketdata/' + this.opts.symbol + '?heartbeat=true&trades=true&top_of_book=false'
      const req = [
        'GET ' + path + ' HTTP/1.1',
        'Host: ' + host,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + key,
        'Sec-WebSocket-Version: 13',
        '', ''
      ].join('\r\n')
      sock.write(req, 'utf8')
    })

    sock.on('data', (chunk: Buffer) => {
      this.lastTickAt = Date.now()
      if (this.reconnectDelay > 1000) {
        // healthy traffic resets the backoff
        this.reconnectDelay = 1000
      }
      if (!handshakeDone) {
        headerBuf = Buffer.concat([headerBuf, chunk])
        const idx = headerBuf.indexOf('\r\n\r\n')
        if (idx === -1) return
        const head = headerBuf.slice(0, idx).toString('utf8')
        if (!head.startsWith('HTTP/1.1 101')) {
          if (!head.includes(' 101 ')) {
            log.warn('WS ' + this.opts.symbol + ' handshake failed: ' + head.split('\r\n')[0])
            this.reconnectDelay = Math.min(this.reconnectDelay, 5000)
            this.destroySocket()
            return
          }
        }
        handshakeDone = true
        this.opened = true
        this.buf = headerBuf.slice(idx + 4)
      } else {
        this.buf = Buffer.concat([this.buf, chunk])
      }
      this.drain()
    })

    sock.on('error', (err: Error) => {
      log.warn('WS ' + this.opts.symbol + ' error: ' + err.message)
      this.destroySocket()
    })

    sock.on('close', () => {
      if (handshakeDone) log.warn('WS ' + this.opts.symbol + ' closed')
      this.destroySocket()
    })

    sock.on('end', () => this.destroySocket())
  }

  private drain(): void {
    while (true) {
      const f = this.parseFrame()
      if (!f) break
      this.handleFrame(f)
    }
  }

  private parseFrame(): RawFrame | undefined {
    const b = this.buf
    if (b.length < 2) return undefined
    const b0 = b[0]
    const b1 = b[1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let off = 2
    if (len === 126) {
      if (b.length < 4) return undefined
      len = b.readUInt16BE(2)
      off = 4
    } else if (len === 127) {
      if (b.length < 10) return undefined
      const hi = b.readUInt32BE(2)
      const lo = b.readUInt32BE(6)
      if (hi > 0) { // absurd size, kill
        log.warn('WS ' + this.opts.symbol + ' absurd frame size')
        this.destroySocket()
        return undefined
      }
      len = lo
      off = 10
    }
    if (masked) off += 4 // server frames are never masked per RFC
    if (b.length < off + len) return undefined
    const payload = b.slice(off, off + len)
    this.buf = b.slice(off + len)
    return { opcode, fin, payload }
  }

  private handleFrame(f: RawFrame): void {
    switch (f.opcode) {
      case 0x1: // text
      case 0x2: // binary (Gemini uses text)
        this.fragments.push(f.payload)
        if (f.fin) {
          const full = Buffer.concat(this.fragments)
          this.fragments = []
          this.onMessage(full.toString('utf8'))
        }
        break
      case 0x8: // close
        try { this.sendFrame(0x8, f.payload.slice(0, 125)) } catch { /* ignore */ }
        this.destroySocket()
        break
      case 0x9: // ping -> pong
        try { this.sendFrame(0xa, f.payload.slice(0, 125)) } catch { /* ignore */ }
        break
      case 0xa: // pong
        break
      default:
        break
    }
  }

  private onMessage(text: string): void {
    if (this.opts.onAnyTick) this.opts.onAnyTick()
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    const type = msg.type
    if (type === 'trade') {
      const price = Number(msg.price)
      if (Number.isFinite(price) && price > 0) {
        this.lastPrice = price
        this.opts.onPrice(price)
      }
      return
    }
    if (type === 'change' || type === 'heartbeat' || type === 'auction' || type === 'block_trade') {
      const events = msg.events as Array<Record<string, unknown>> | undefined
      if (Array.isArray(events)) {
        for (const ev of events) {
          if (ev.type === 'trade') {
            const price = Number(ev.price)
            if (Number.isFinite(price) && price > 0) {
              this.lastPrice = price
              this.opts.onPrice(price)
            }
          }
        }
      }
    }
  }

  // Build a masked client frame (clients must mask outgoing payload).
  private sendFrame(opcode: number, payload: Buffer): void {
    const s = this.sock
    if (!s || !this.opened) return
    const mask = randomBytes(4)
    const masked = Buffer.allocUnsafe(payload.length)
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4]
    const head = Buffer.allocUnsafe(2)
    head[0] = 0x80 | opcode
    head[1] = 0x80 | payload.length
    s.write(Buffer.concat([head, mask, masked]))
  }
}
