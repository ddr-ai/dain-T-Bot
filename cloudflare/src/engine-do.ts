// The engine Durable Object. ONE instance (idFromName('main')) holds the
// entire bot brain in strongly consistent SQLite-backed storage: state,
// encrypted credentials and the tick lock. All /api requests and the
// every-minute cron tick are forwarded here by the worker entry point
// (index.ts), so reads never race writes the way they could on Workers KV.
//
// Handlers:
//   POST /__tick        -> one engine tick (cron or manual), errors swallowed
//                          like the Netlify scheduled function did
//   any  /api/*          -> the REST API (api.ts), same routes as Netlify

import { initEngineConfig } from '../engine/config.ts'
import { configureEngineStore } from '../engine/blobs.ts'
import type { EngineStore } from '../engine/blobs.ts'
import { engineTick } from '../engine/tick.ts'
import apiHandler from '../functions/api.ts'

// Minimal ambient types (wrangler provides the real ones at deploy time).
export interface DOStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
}

export interface DurableObjectStateLike {
  storage: DOStorageLike
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store'
}

export class EngineDO {
  constructor(
    private ctx: DurableObjectStateLike,
    private env: Record<string, unknown>
  ) {}

  private prepare(): void {
    initEngineConfig(this.env)
    const storage = this.ctx.storage
    const kv: EngineStore = {
      get: async (k) => (await storage.get<string>(k)) ?? null,
      set: async (k, v) => {
        await storage.put(k, v)
      },
      delete: async (k) => {
        await storage.delete(k)
      }
    }
    configureEngineStore(kv)
  }

  async fetch(req: Request): Promise<Response> {
    this.prepare()
    const u = new URL(req.url)

    if (req.method === 'POST' && (u.pathname === '/__tick' || u.pathname === '/__tick/')) {
      try {
        const r = await engineTick()
        return new Response(JSON.stringify({ ok: true, ...r }), { status: 200, headers: JSON_HEADERS })
      } catch {
        // Next scheduled run retries; failures also land in the activity feed.
        return new Response(JSON.stringify({ ok: false }), { status: 200, headers: JSON_HEADERS })
      }
    }

    return apiHandler(req)
  }
}
