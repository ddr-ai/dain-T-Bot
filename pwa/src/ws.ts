// WebSocket subscription to the backend /ws stream with auto-reconnect.
// Events: price ticks, activity log entries, trade notifications, status
// changes and settings updates. Falls back silently when offline - the
// REST poll in App covers the gaps.

import type { WsEvent } from './types.ts'

export interface SocketHandlers {
  onPrice?: (symbol: string, price: number) => void
  onActivity?: (a: unknown) => void
  onTrade?: (t: unknown) => void
  onStatus?: (s: unknown) => void
  onSettings?: (s: unknown) => void
  onOpen?: () => void
  onClose?: () => void
}

export function connectSocket(handlers: SocketHandlers): { close: () => void } {
  const base = (import.meta.env.VITE_API_BASE as string | undefined) ?? window.location.origin
  const url = base.replace(/^http/, 'ws') + '/ws'
  let closedByApp = false
  let attempt = 0

  const open = (): WebSocket => {
    const ws = new WebSocket(url)
    ws.onopen = () => {
      attempt = 0
      handlers.onOpen?.()
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as WsEvent
        if (msg.t === 'price') {
          const p = msg.data as { symbol: string, price: number }
          handlers.onPrice?.(p.symbol, p.price)
        } else if (msg.t === 'activity') handlers.onActivity?.(msg.data)
        else if (msg.t === 'trade') handlers.onTrade?.(msg.data)
        else if (msg.t === 'status') handlers.onStatus?.(msg.data)
        else if (msg.t === 'settings') handlers.onSettings?.(msg.data)
      } catch {
        /* ignore malformed */
      }
    }
    ws.onclose = () => {
      handlers.onClose?.()
      if (!closedByApp) {
        const delay = Math.min(30000, 1000 * Math.pow(2, attempt))
        attempt += 1
        setTimeout(() => {
          if (!closedByApp) socket = open()
        }, delay)
      }
    }
    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
    return ws
  }

  let socket = open()
  return {
    close: () => {
      closedByApp = true
      try {
        socket.close()
      } catch {
        /* ignore */
      }
    }
  }
}
