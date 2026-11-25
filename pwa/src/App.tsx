import { useCallback, useEffect, useRef, useState } from 'react'
import type { Activity, Settings, Status, SymbolTick, Trade } from './types.ts'
import type { Performance } from './types.ts'
import { api } from './api.ts'
import { connectSocket } from './ws.ts'
import { Dashboard, Watchlist } from './components/Dashboard.tsx'
import { ActivityFeed, TradesList } from './components/Feeds.tsx'
import { SettingsScreen } from './components/SettingsScreen.tsx'

type Tab = 'dashboard' | 'watchlist' | 'activity' | 'trades' | 'settings'

export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('dashboard')
  const [status, setStatus] = useState<Status | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [perf, setPerf] = useState<Performance | null>(null)
  const [trades, setTrades] = useState<Trade[]>([])
  const [activity, setActivity] = useState<Activity[]>([])
  const [prices, setPrices] = useState<Record<string, SymbolTick>>({})
  const [connected, setConnected] = useState(false)
  const [toast, setToast] = useState<{ msg: string, err: boolean } | null>(null)
  const [installEvent, setInstallEvent] = useState<{ prompt: () => void } | null>(null)
  const wsActivityRef = useRef(false)

  const notify = useCallback((msg: string, err = false): void => {
    setToast({ msg, err })
    setTimeout(() => setToast(null), 3500)
  }, [])

  const refreshAll = useCallback((): void => {
    api.status().then((s) => { setStatus(s); setBootError(null) }).catch((e) => {
      const msg = String((e as Error).message)
      // the API 401 body says: missing or invalid Authorization bearer token
      setBootError(msg.includes('missing or invalid')
        ? 'API token required - paste it below'
        : 'cannot reach the engine: ' + msg)
    })
    api.settings().then(setSettings).catch(() => undefined)
    api.performance().then(setPerf).catch(() => undefined)
    api.trades(50).then(setTrades).catch(() => undefined)
    api.activity(60).then(setActivity).catch(() => undefined)
    api.status().then((s) => setPrices(s.prices)).catch(() => undefined)
  }, [])

  useEffect(() => {
    refreshAll()
    const poll = setInterval(refreshAll, 12000)
    return () => clearInterval(poll)
  }, [refreshAll])

  useEffect(() => {
    // incoming activity via WS is prepended without waiting for the poll
    const sock = connectSocket({
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onPrice: (symbol, price) => {
        setPrices((prev) => ({ ...prev, [symbol]: { price, at: Date.now() } }))
        setStatus((prev) => (prev ? { ...prev, prices: { ...prev.prices, [symbol]: { price, at: Date.now() } } } : prev))
      },
      onActivity: (a) => {
        if (!wsActivityRef.current) return
        setActivity((prev) => [a as Activity, ...prev].slice(0, 300))
      },
      onTrade: (t) => {
        const data = t as { kind?: string }
        if (data.kind === 'entry' || data.kind === 'exit' || data.kind === 'position-closed') {
          refreshAll()
        }
      },
      onStatus: () => refreshAll()
    })
    return () => sock.close()
  }, [refreshAll])

  // only trust WS-activity while on the activity tab (avoids dup rows)
  useEffect(() => {
    wsActivityRef.current = tab === 'activity'
  }, [tab])

  useEffect(() => {
    const handler = (e: Event): void => {
      e.preventDefault()
      setInstallEvent(e as unknown as { prompt: () => void })
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const toggleAutopilot = (on: boolean): void => {
    api.setAutopilot(on).then(
      () => {
        notify(on ? 'Autopilot ON - the bot now acts on its own' : 'Autopilot OFF - positions still managed')
        refreshAll()
      },
      (e) => notify('Failed: ' + String((e as Error).message), true)
    )
  }

  const riskSlider = (v: number): void => {
    if (settings) setSettings({ ...settings, riskReward: v })
    api.updateSettings({ riskReward: v }).catch((e) => notify('Slider save failed: ' + String((e as Error).message), true))
  }

  const emergencyStop = (): void => {
    api.emergencyStop().then(
      () => {
        notify('Emergency stop sent: orders cancelled, positions flattened, autopilot halted')
        refreshAll()
      },
      (e) => notify('Emergency stop failed: ' + String((e as Error).message), true)
    )
  }

  // Run-window flow: START a hosted run for N minutes, or STOP new entries.
  const startRun = (minutes: number): void => {
    api.startRun(minutes).then(
      () => {
        notify('RUN STARTED for ' + (minutes / 60) + 'h - the engine runs on the server, you can close this page')
        refreshAll()
      },
      (e) => notify('Start failed: ' + String((e as Error).message), true)
    )
  }

  const stopRun = (): void => {
    api.stopRun().then(
      () => {
        notify('Run stopped - open positions keep being managed until they close')
        refreshAll()
      },
      (e) => notify('Stop failed: ' + String((e as Error).message), true)
    )
  }

  if (status === null || settings === null) {
    return (
      <div className="boot">
        <div className="h1">Crypto Autopilot</div>
        {bootError === null
          ? <div className="muted">connecting to the engine...</div>
          : (
            <div>
              <div className="muted err-text">{bootError}</div>
              <input
                className="input"
                type="password"
                placeholder="API token"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
              />
              <button
                className="primary big-btn"
                onClick={() => { api.setToken(tokenInput); refreshAll() }}
              >
                Connect
              </button>
              <div className="muted small" style={{ marginTop: 10 }}>
                The token was shared with you. It is stored only on this device.
              </div>
            </div>
            )}
      </div>
    )
  }

  return (
    <div className="app">
      {toast !== null && <div className={'toast ' + (toast.err ? 'err' : 'ok')}>{toast.msg}</div>}

      {tab === 'dashboard' && (
        <Dashboard
          status={status}
          settings={settings}
          perf={perf}
          connected={connected}
          onToggleAutopilot={toggleAutopilot}
          onRiskSlider={riskSlider}
          onEmergencyStop={emergencyStop}
          onStartRun={startRun}
          onStopRun={stopRun}
        />
      )}
      {tab === 'watchlist' && <Watchlist prices={prices} />}
      {tab === 'activity' && <ActivityFeed items={activity} />}
      {tab === 'trades' && <TradesList trades={trades} />}
      {tab === 'settings' && <SettingsScreen status={status} settings={settings} notify={notify} onRefresh={refreshAll} />}

      <nav className="tabbar">
        <TabBtn active={tab === 'dashboard'} onClick={() => setTab('dashboard')} label="Home" />
        <TabBtn active={tab === 'watchlist'} onClick={() => setTab('watchlist')} label="Prices" />
        <TabBtn active={tab === 'activity'} onClick={() => setTab('activity')} label="Activity" />
        <TabBtn active={tab === 'trades'} onClick={() => setTab('trades')} label="Trades" />
        <TabBtn active={tab === 'settings'} onClick={() => setTab('settings')} label="Settings" />
      </nav>

      {installEvent !== null && (
        <button className="install" onClick={() => { installEvent.prompt(); setInstallEvent(null) }}>
          Install app
        </button>
      )}
    </div>
  )
}

function TabBtn(props: { active: boolean, onClick: () => void, label: string }): JSX.Element {
  return (
    <button className={'tab ' + (props.active ? 'active' : '')} onClick={props.onClick}>
      {props.label}
    </button>
  )
}
