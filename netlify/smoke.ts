// Local smoke test for the serverless engine: boots a paper-mode tick
// against LIVE Gemini market data using an in-memory blobs stub, then
// verifies state, run-window start, and credential encryption round-trip.
// Run: PAPER_TRADING=true node --experimental-transform-types --no-warnings netlify/smoke.ts
// gitignore-adjacent: this file never touches real credentials.

import { loadState, saveState, saveCreds, loadCreds } from './engine/blobs.ts'
import { engineTick } from './engine/tick.ts'
import { runEndsAt, runActive } from './engine/state.ts'

async function main(): Promise<void> {
  process.env.CREDS_MASTER_KEY = 'smoke-master-key-for-test-only'
  const st = await loadState()
  if (st.settings.paper !== true) throw new Error('smoke requires PAPER_TRADING=true')
  console.log('[1] seeded state ok: mode', st.settings.paper ? 'paper' : 'live', '| symbols', JSON.stringify(st.settings.autopilotOn))

  // credentials encryption round-trip
  await saveCreds({ key: 'smoke-key-aaaaaaaa', secret: 'smoke-secret-bbbbbb' })
  const creds = await loadCreds()
  if (!creds || creds.key !== 'smoke-key-aaaaaaaa' || creds.secret !== 'smoke-secret-bbbbbb') {
    throw new Error('creds crypto round-trip FAILED')
  }
  console.log('[2] AES-256-GCM creds round-trip ok')

  // start a 60-minute run, then tick twice
  st.run.startedAt = Date.now()
  st.run.minutes = 60
  st.settings.autopilotOn = true
  await saveState(st)
  console.log('[3] run started: ends at', new Date(runEndsAt(st)).toISOString(), 'active:', runActive(st))

  const t1 = await engineTick()
  console.log('[4] tick 1:', JSON.stringify(t1))

  const st2 = await loadState()
  console.log('[5] state after tick: prices', Object.keys(st2.prices).join(','), '| lastTickAt', st2.lastTickAt, '| equitySnap', JSON.stringify(st2.equitySnap))
  if (Object.keys(st2.prices).length < 1) throw new Error('no prices recorded')
  if (st2.equitySnap.at <= 0) throw new Error('equitySnap not set')
  const acts = st2.activity.slice(-5)
  for (const a of acts) console.log('    activity:', a.kind, '|', a.msg.slice(0, 110))

  const t2 = await engineTick()
  console.log('[6] tick 2:', JSON.stringify(t2))

  const st3 = await loadState()
  console.log('[7] corr table:', JSON.stringify(st3.corr))
  console.log('SMOKE OK')
}

main().catch((e) => {
  console.error('SMOKE FAILED:', (e as Error).stack)
  process.exit(1)
})
