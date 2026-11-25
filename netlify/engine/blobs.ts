// Netlify Blobs persistence: the entire engine brain lives in three blobs on
// the site's private blob store. Blobs are only reachable through the site's
// own functions - never from the browser.

import { getStore } from '@netlify/blobs'
import { mergeState, seedState } from './state.ts'
import type { ServerlessState } from './state.ts'
import { encryptForBlob, decryptFromBlob } from './crypto.ts'

const STATE_KEY = 'state'
const CREDS_KEY = 'creds'
const LOCK_KEY = 'tick-lock'
const LOCK_MAX_AGE_MS = 180_000   // a crash between set/clear cannot wedge the engine for long

function engineStore() {
  return getStore('engine')
}

export async function loadState(): Promise<ServerlessState> {
  const store = engineStore()
  const raw = await store.get(STATE_KEY)
  if (!raw) return seedState()
  try {
    return mergeState(JSON.parse(raw))
  } catch {
    return seedState()
  }
}

export async function saveState(st: ServerlessState): Promise<void> {
  await engineStore().set(STATE_KEY, JSON.stringify(st))
}

// ---- credentials (AES-256-GCM encrypted blob) ----

export interface GeminiCreds {
  key: string
  secret: string
}

export async function saveCreds(creds: GeminiCreds): Promise<void> {
  const doc = await encryptForBlob(JSON.stringify(creds))
  await engineStore().set(CREDS_KEY, JSON.stringify(doc))
}

export async function loadCreds(): Promise<GeminiCreds | undefined> {
  const raw = await engineStore().get(CREDS_KEY)
  if (!raw) return undefined
  try {
    const plain = await decryptFromBlob(JSON.parse(raw))
    const creds = JSON.parse(plain) as GeminiCreds
    if (typeof creds.key === 'string' && typeof creds.secret === 'string' && creds.key.length > 0) return creds
    return undefined
  } catch {
    // wrong master key or corrupted blob: treat as empty, never crash
    return undefined
  }
}

export async function clearCreds(): Promise<void> {
  await engineStore().delete(CREDS_KEY)
}

// ---- tick lock: at most one engine tick runs at a time ----

export async function tryAcquireTickLock(): Promise<boolean> {
  const store = engineStore()
  const raw = await store.get(LOCK_KEY)
  if (raw) {
    try {
      const lock = JSON.parse(raw) as { at: number }
      if (Date.now() - lock.at < LOCK_MAX_AGE_MS) return false
    } catch {
      // corrupt lock: steal it
    }
  }
  await store.set(LOCK_KEY, JSON.stringify({ at: Date.now() }))
  return true
}

export async function releaseTickLock(): Promise<void> {
  await engineStore().delete(LOCK_KEY)
}
