// Minimal RFC6455 WebSocket SERVER so clients get pushed prices, trade
// events, and the activity feed in real time. Zero dependencies.
// Protocol: clients connect to /ws and receive JSON envelopes: {t: type, data}.

import { createHash, randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import type { Socket } from 'node:net'
import { log } from '../util/logger.ts'
import type { EventBus } from '../notify/events.ts'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

interface Client {
  socket: Socket
  buf: Buffer
  alive: boolean
}

function sendFrame(socket: Socket, opcode: number, payload: Buffer): void {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[1] = 127
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(len, 6)
  }
  header[0] = 0x80 | opcode
  socket.write(Buffer.concat([header, payload]))
}

export function attachWebsocket(server: Server, events: EventBus): void {
  const clients = new Set<Client>()

  const broadcast = (msg: unknown): void => {
    const payload = Buffer.from(JSON.stringify(msg), 'utf8')
    for (const c of clients) {
      try {
        sendFrame(c.socket, 0x1, payload)
      } catch {
        try { c.socket.destroy() } catch { /* ignore */ }
      }
    }
  }

  server.on('upgrade', (req, socket: Socket, head: Buffer) => {
    const url = req.url ?? ''
    if (!url.startsWith('/ws')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    )
    if (head.length > 0) socket.write(head)
    const client: Client = { socket, buf: Buffer.alloc(0), alive: true }
    clients.add(client)
    log.info('WS client connected (' + clients.size + ' total)')

    socket.on('data', (chunk: Buffer) => {
      client.buf = Buffer.concat([client.buf, chunk])
      // parse (masked) client frames; we only use heartbeat pings
      while (client.buf.length >= 2) {
        const b0 = client.buf[0]
        const b1 = client.buf[1]
        const opcode = b0 & 0x0f
        const masked = (b1 & 0x80) !== 0
        let len = b1 & 0x7f
        let off = 2
        if (len === 126) {
          if (client.buf.length < 4) return
          len = client.buf.readUInt16BE(2)
          off = 4
        } else if (len === 127) {
          if (client.buf.length < 10) return
          len = Number(client.buf.readBigUInt64BE(6))
          off = 10
        }
        if (client.buf.length < off + len + (masked ? 4 : 0)) return
        client.buf = client.buf.slice(off + len + (masked ? 4 : 0))
        if (opcode === 0x8) { // close
          socket.destroy()
          return
        }
        if (opcode === 0x9) { // ping -> pong (client frames are masked; echo)
          sendFrame(socket, 0xa, Buffer.alloc(0))
        }
      }
    })

    const drop = (): void => {
      clients.delete(client)
      log.info('WS client disconnected (' + clients.size + ' total)')
    }
    socket.on('close', drop)
    socket.on('error', drop)
    socket.on('end', drop)
  })

  // Push event bus traffic to all connected clients.
  const names = ['price', 'activity', 'trade', 'status', 'settings'] as const
  for (const n of names) {
    events.on(n, (payload) => broadcast({ t: n, data: payload }))
  }

  // heartbeat: server ping every 30s keeps intermediaries honest
  setInterval(() => {
    for (const c of clients) {
      try {
        sendFrame(c.socket, 0x9, Buffer.from(randomBytes(4).slice(0, 4)))
      } catch {
        try { c.socket.destroy() } catch { /* ignore */ }
      }
    }
  }, 30000)
}
