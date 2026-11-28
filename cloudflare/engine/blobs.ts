// Engine persistence for the Cloudflare Workers port. Same interface and
// semantics as netlify/engine/blobs.ts (loadState/saveState, encrypted creds,
// tick lock), but the string key-value backend is injected instead of
// Netlify Blobs:
//
//   * in production it is a Durable Object's SQLite-backed storage
//     (engine-do.ts wires it up), which is strongly consistent - unlike
//     Workers KV, whose eventual consistency and 1,000 writes/day free
//     cap make it wrong for a trading engine's read-modify-write state
//   * in tests it is a plain Map
//
// Every engine module imports these functions from './blobs.ts' exactly like
// the Netlify version, so state.ts / scan.ts / manager.ts / tick.ts are
// byte-identical copies.

import { mergeState, seedState } from './state.ts'
import type { ServerlessState } from './state.ts'
import { encryptForBlob, decryptFromBlob } from './crypto.ts'

const STATE_KEY = 'state'
const CREDS_KEY = 'creds'
const LOCK_KEY = 'tick-lock'
const LOCK_MAX_AGE_MS = 180_000   // a crash between set/clear cannot wedge the engine for long

// Minimal string KV contract both backends satisfy.
export interface EngineStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<boolean | void>
}

let store: EngineStore | null = null

export function configureEngineStore(s: EngineStore): void {
  store = s
}

function kv(): EngineStore {
  if (!store) throw new Error('engine store not configured: call configureEngineStore() first')
  return store
}

export async function loadState(): Promise<ServerlessState> {
  const raw = await kv().get(STATE_KEY)
  if (!raw) return seedState()
  try {
    return mergeState(JSON.parse(raw))
  } catch {
    return seedState()
  }
}

export async function saveState(st: ServerlessState): Promise<void> {
  await kv().set(STATE_KEY, JSON.stringify(st))
}

// ---- credentials (AES-256-GCM encrypted at rest) ----

export interface GeminiCreds {
  key: string
  secret: string
}

export async function saveCreds(creds: GeminiCreds): Promise<void> {
  const doc = await encryptForBlob(JSON.stringify(creds))
  await kv().set(CREDS_KEY, JSON.stringify(doc))
}

export async function loadCreds(): Promise<GeminiCreds | undefined> {
  const raw = await kv().get(CREDS_KEY)
  if (!raw) return undefined
  try {
    const plain = await decryptFromBlob(JSON.parse(raw))
    const creds = JSON.parse(plain) as GeminiCreds
    if (typeof creds.key === 'string' && typeof creds.secret === 'string' && creds.key.length > 0) return creds
    return undefined
  } catch {
    // wrong master key or corrupted record: treat as empty, never crash
    return undefined
  }
}

export async function clearCreds(): Promise<void> {
  await kv().delete(CREDS_KEY)
}

// ---- tick lock: at most one engine tick runs at a time ----
// (Durable Objects interleave requests at await points, so the lock still
// matters even with a single instance.)

export async function tryAcquireTickLock(): Promise<boolean> {
  const k = kv()
  const raw = await k.get(LOCK_KEY)
  if (raw) {
    try {
      const lock = JSON.parse(raw) as { at: number }
      if (Date.now() - lock.at < LOCK_MAX_AGE_MS) return false
    } catch {
      // corrupt lock: steal it
    }
  }
  await k.set(LOCK_KEY, JSON.stringify({ at: Date.now() }))
  return true
}

export async function releaseTickLock(): Promise<void> {
  await kv().delete(LOCK_KEY)
}
