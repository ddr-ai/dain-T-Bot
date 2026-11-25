// One engine tick: manage open positions, then (if the run is active) scan
// for new entries. Locked so overlapping invocations (scheduled tick racing a
// manual /api/tick) cannot double-enter. All output lands in the Blobs state.

import { loadState, saveState, loadCreds, tryAcquireTickLock, releaseTickLock } from './blobs.ts'
import type { ServerlessState } from './state.ts'
import type { TickContext } from './manager.ts'
import { manageAll } from './manager.ts'
import { scan } from './scan.ts'

export interface TickResult {
  ok: boolean
  skipped?: string
  managed: number
  scanned: boolean
  durationMs: number
}

export async function engineTick(): Promise<TickResult> {
  const started = Date.now()
  const acquired = await tryAcquireTickLock()
  if (!acquired) {
    return { ok: true, skipped: 'another tick is already running', managed: 0, scanned: false, durationMs: 0 }
  }
  try {
    const st = await loadState()
    const creds = await loadCreds()
    const ctx: TickContext = { st, creds }
    const openPositions = st.positions.length

    await manageAll(ctx)
    const autopilotWasOn = st.settings.autopilotOn
    await scan(ctx)

    st.lastTickAt = Date.now()
    await saveState(st)
    return {
      ok: true,
      managed: openPositions,
      scanned: autopilotWasOn,
      durationMs: Date.now() - started
    }
  } catch (e) {
    // Never wedge the lock: on failure, best-effort save what we have.
    try {
      const st: ServerlessState = await loadState()
      st.activity.push({ ts: Date.now(), kind: 'error', msg: 'Engine tick failed: ' + String((e as Error).message) })
      await saveState(st)
    } catch {
      // state itself unreachable: nothing to do
    }
    throw e
  } finally {
    await releaseTickLock()
  }
}
