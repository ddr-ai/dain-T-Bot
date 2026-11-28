// Cloudflare Workers entry point for the dain-T-Bot engine.
//
//   fetch(req, env, ctx)      -> forward every request to the single
//                                "main" engine Durable Object
//   scheduled(event, env, ctx) -> cron trigger ("* * * * *", every minute,
//                                free plan) fires one engine tick into the
//                                same Durable Object
//
// The Durable Object (engine-do.ts) owns all state, runs the REST API
// (api.ts) and the tick (engine/tick.ts). Unlimited deploys: `wrangler
// deploy` from GitHub Actions, no build-minute quota anywhere.

import { EngineDO } from './engine-do.ts'

export { EngineDO }

// Minimal ambient types (wrangler provides the real ones at deploy time).
interface DurableObjectIdLike {
  // opaque
}
interface DurableObjectStubLike {
  fetch(req: Request): Promise<Response>
}
interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike
  get(id: DurableObjectIdLike): DurableObjectStubLike
}
export interface Env {
  ENGINE: DurableObjectNamespaceLike
}
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
}
interface ScheduledEventLike {
  cron: string
  scheduledTime: number
}

function engineStub(env: Env): DurableObjectStubLike {
  return env.ENGINE.get(env.ENGINE.idFromName('main'))
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContextLike): Promise<Response> {
    return engineStub(env).fetch(req)
  },

  async scheduled(_event: ScheduledEventLike, env: Env, ctx: ExecutionContextLike): Promise<void> {
    const tick = engineStub(env).fetch('https://engine.internal/__tick', { method: 'POST' })
    ctx.waitUntil(tick)
  }
}
