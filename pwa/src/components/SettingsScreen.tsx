import { useState } from 'react'
import type { Settings, Status } from '../types.ts'
import { api, baseUrl } from '../api.ts'

interface SettingsScreenProps {
  status: Status
  settings: Settings
  onRefresh: () => void
  notify: (msg: string, isError?: boolean) => void
}

export function SettingsScreen(props: SettingsScreenProps): JSX.Element {
  const { settings } = props
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [token, setToken] = useState(api.getToken())
  const [busy, setBusy] = useState('')

  const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(name)
    setApiKey('')
    setApiSecret('')
    try {
      await fn()
    } catch (e) {
      props.notify('Failed: ' + String((e as Error).message), true)
    } finally {
      setBusy('')
    }
  }

  const s = settings

  return (
    <div className="page">
      <div className="h2">Settings</div>

      <section className="card">
        <div className="h3">Trading mode</div>
        <div className="muted small">
          PAPER simulates fills locally (no funds at risk, no Gemini key needed). LIVE places real orders on your
          Gemini account. You can only switch with no open positions.
        </div>
        <div className="row spread pad-top">
          <div className={'badge ' + (s.paper ? 'paper' : 'live')}>{s.paper ? 'PAPER' : 'LIVE'}</div>
          <button
            className={s.paper ? 'primary' : 'danger'}
            disabled={busy.length > 0 || (s.paper ? false : props.status.positions.length > 0)}
            onClick={() =>
              run('mode', async () => {
                await api.updateSettings({ paper: !s.paper })
                props.notify('Switched to ' + (!s.paper ? 'LIVE' : 'PAPER') + ' mode')
                props.onRefresh()
              })
            }
          >
            {s.paper ? 'Switch to LIVE' : 'Switch to PAPER'}
          </button>
        </div>
        {!s.paper && <div className="warn small">LIVE mode trades real money with automated decisions. Validate in paper first!</div>}
      </section>

      <section className="card">
        <div className="h3">Risk</div>
        <LabeledNum
          label="Risk per trade (% of equity)"
          value={s.riskPct}
          min={0.1}
          max={s.maxRiskPct ?? 3}
          step={0.1}
          onSave={(v) =>
            run('risk', async () => {
              await api.updateSettings({ riskPct: v })
              props.notify('Risk % updated (affects future trades only)')
            })
          }
        />
        <LabeledNum
          label="Max trades per symbol per day"
          value={s.maxTradesPerSymbolPerDay}
          min={1}
          max={10}
          step={1}
          onSave={(v) =>
            run('mt', async () => {
              await api.updateSettings({ maxTradesPerSymbolPerDay: Math.round(v) })
              props.notify('Max trades/day updated')
            })
          }
        />
        <LabeledNum
          label="Daily loss warning (%)"
          value={s.dailyLossWarnPct}
          min={0.5}
          max={10}
          step={0.5}
          onSave={(v) =>
            run('dw', async () => {
              await api.updateSettings({ dailyLossWarnPct: v })
              props.notify('Daily loss warning updated')
            })
          }
        />
        <LabeledNum
          label="Daily loss limit - flatten (%)"
          value={s.dailyLossLimitPct}
          min={1}
          max={15}
          step={0.5}
          onSave={(v) =>
            run('dl', async () => {
              await api.updateSettings({ dailyLossLimitPct: v })
              props.notify('Daily loss limit updated')
            })
          }
        />
      </section>

      <section className="card">
        <div className="h3">Notifications</div>
        <Check
          label="Fills and exits"
          checked={s.notifyFills}
          onChange={(c) => run('nf', async () => { await api.updateSettings({ notifyFills: c }); props.onRefresh() })}
        />
        <Check
          label="Stop / breakeven / trailing moves"
          checked={s.notifyStops}
          onChange={(c) => run('ns', async () => { await api.updateSettings({ notifyStops: c }); props.onRefresh() })}
        />
        <Check
          label="Circuit breaker events"
          checked={s.notifyBreaker}
          onChange={(c) => run('nb', async () => { await api.updateSettings({ notifyBreaker: c }); props.onRefresh() })}
        />
        <div className="muted small">Push notifications are delivered while the app is open (PWA) - the backend keeps acting 24/7 regardless.</div>
      </section>

      <section className="card">
        <div className="h3">Gemini API credentials</div>
        <div className="muted small">
          Stored AES-256-GCM encrypted on the backend. Create a key with ONLY "Balances" + "Orders" permissions and
          WITHDRAWALS DISABLED.
        </div>
        <div className={'badge ' + (props.status.hasCredentials ? 'ok' : 'bad')}>
          {props.status.hasCredentials ? 'credentials configured on backend' : 'no credentials (paper mode OK)'}
        </div>
        <input
          className="input"
          placeholder="API key"
          value={apiKey}
          autoComplete="off"
          onChange={(e) => setApiKey(e.target.value)}
        />
        <input
          className="input"
          placeholder="API secret"
          type="password"
          autoComplete="off"
          value={apiSecret}
          onChange={(e) => setApiSecret(e.target.value)}
        />
        <div className="row pad-top">
          <button
            className="primary"
            disabled={busy.length > 0 || apiKey.length < 10 || apiSecret.length < 10}
            onClick={() =>
              run('save', async () => {
                await api.saveCredentials(apiKey, apiSecret)
                props.notify('Credentials saved (encrypted at rest)')
                props.onRefresh()
              })
            }
          >
            Save credentials
          </button>
          <button
            className="ghost"
            disabled={busy.length > 0}
            onClick={() =>
              run('del', async () => {
                await api.deleteCredentials()
                props.notify('Credentials removed')
                props.onRefresh()
              })
            }
          >
            Remove
          </button>
        </div>
      </section>

      <section className="card">
        <div className="h3">Backend access</div>
        <div className="muted small mono">{baseUrl()}</div>
        <input
          className="input"
          placeholder={'API bearer token (optional, if backend requires one)'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <div className="row pad-top">
          <button
            className="primary"
            onClick={() => {
              api.setToken(token)
              props.notify('Token saved on this device')
            }}
          >
            Save token
          </button>
        </div>
      </section>
    </div>
  )
}

function LabeledNum(props: { label: string, value: number, min: number, max: number, step: number, onSave: (v: number) => void }): JSX.Element {
  const [v, setV] = useState(props.value)
  return (
    <div className="pad-top">
      <div className="row spread">
        <span className="small">{props.label}</span>
        <span className="big">{v}</span>
      </div>
      <input className="slider" type="range" min={props.min} max={props.max} step={props.step} value={v} onChange={(e) => setV(Number(e.target.value))} />
      <button className="ghost small-btn" onClick={() => props.onSave(v)}>
        save
      </button>
    </div>
  )
}

function Check(props: { label: string, checked: boolean, onChange: (c: boolean) => void }): JSX.Element {
  return (
    <label className="check">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.label}</span>
    </label>
  )
}
