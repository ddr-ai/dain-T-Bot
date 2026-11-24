// Bootstrap: wires config, store, credentials vault, Gemini clients,
// the Autopilot engine and the HTTP/WS API server together.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { log } from './util/logger.ts'
import { loadConfig } from './config/env.ts'
import { Store } from './store/store.ts'
import { EventBus } from './notify/events.ts'
import { CredentialsStore } from './secure/credentials.ts'
import { GeminiPublic } from './gemini/public.ts'
import { GeminiRest } from './gemini/rest.ts'
import { Autopilot } from './engine/autopilot.ts'
import { createHttpServer } from './api/http.ts'
import { attachWebsocket } from './api/ws-server.ts'

async function main(): Promise<void> {
  const cfg = loadConfig()
  mkdirSync(cfg.dataDir, { recursive: true })

  const events = new EventBus()
  const store = new Store(cfg.dataDir, cfg, events)
  const creds = new CredentialsStore(join(cfg.dataDir, 'credentials.enc'), cfg.encryptionKey)
  const pub = new GeminiPublic(cfg.publicBaseUrl)

  // Credential resolution: encrypted vault first, then .env values.
  const rest = new GeminiRest(cfg.privateBaseUrl, () => {
    const v = creds.load()
    if (v) return v
    if (cfg.apiKey && cfg.apiSecret) return { key: cfg.apiKey, secret: cfg.apiSecret }
    return undefined
  })

  const engine = new Autopilot(cfg, pub, rest, store, events, creds)

  const server = createHttpServer({ cfg, store, engine, creds })
  attachWebsocket(server, events)
  server.listen(cfg.port, () => {
    log.info('API listening on http://0.0.0.0:' + cfg.port + ' (WS on /ws)')
  })

  await engine.start()

  log.info('=== Gemini Autopilot Bot ===')
  log.info('mode: ' + (store.state.settings.paper ? 'PAPER (simulated fills)' : 'LIVE (real funds!)'))
  log.info('symbols: ' + cfg.symbols.join(', '))
  log.info('private API base: ' + cfg.privateBaseUrl)
  log.info('autopilot is ' + (store.state.settings.autopilotOn ? 'ON' : 'OFF') + ' - flip it in the app or via REST')

  const shutdown = (sig: string): void => {
    log.info('received ' + sig + ': stopping engine and flushing state...')
    void engine.stop().then(() => {
      store.saveNow()
      server.close()
      process.exit(0)
    })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((e) => {
  log.error('fatal: ' + String((e as Error).stack ?? e))
  process.exit(1)
})
