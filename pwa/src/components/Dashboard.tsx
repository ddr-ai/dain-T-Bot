import { useEffect, useState } from 'react'
import type { Performance, Position, Settings, Status, SymbolTick } from '../types.ts'
import { api } from '../api.ts'
import { fmtPct, fmtPrice, fmtQty, fmtSignedUsd, fmtTime, fmtUsd, pnlClass } from '../format.ts'
import { Sparkline } from './Sparkline.tsx'

interface DashboardProps {
  status: Status
  settings: Settings
  perf: Performance | null
  onToggleAutopilot: (on: boolean) => void
  onRiskSlider: (v: number) => void
  onEmergencyStop: () => void
  connected: boolean
}

export function Dashboard(props: DashboardProps): JSX.Element {
  const { status } = props
  const [confirmStop, setConfirmStop] = useState(false)

  useEffect(() => {
    if (!confirmStop) return
    const t = setTimeout(() => setConfirmStop(false), 5000)
    return () => clearTimeout(t)
  }, [confirmStop])

  const positions = status.positions
  const bitmap = props.settings

  const statusLine = (): string => {
    if (status.guardLock !== undefined && status.guardLock) return 'Circuit breaker tripped - manual reset needed'
    if (status.haltNew) return 'New entries paused today (' + status.haltReason + '); positions still managed'
    if (!status.autopilotOn) return 'Autopilot: Off'
    if (status.stalePrices !== undefined && status.stalePrices.length > 0) return 'Autopilot: scanning paused (stale prices: ' + status.stalePrices.join(', ') + ')'
    if (positions.length > 0) return 'Autopilot: managing ' + positions.length + ' open position' + (positions.length > 1 ? 's' : '') + ', scanning for more'
    return 'Autopilot: scanning for setups...'
  }

  return (
    <div className="page">
      <div className={'badge ' + (status.mode === 'live' ? 'live' : 'paper')}>{status.mode === 'live' ? 'LIVE MODE' : 'PAPER MODE'}</div>
      <div className={'badge ' + (props.connected ? 'ok' : 'bad')}>{props.connected ? 'WS connected' : 'offline / reconnecting'}</div>

      <section className="card autopilot">
        <div className="row spread">
          <div>
            <div className="h1">{status.autopilotOn ? 'Autopilot ON' : 'Autopilot OFF'}</div>
            <div className="muted">{statusLine()}</div>
          </div>
          <button className={'toggle ' + (status.autopilotOn ? 'on' : '')} onClick={() => props.onToggleAutopilot(!status.autopilotOn)} aria-label="toggle autopilot">
            <span className="knob" />
          </button>
        </div>
      </section>

      <section className="row2">
        <div className="card stat">
          <div className="muted small">Equity</div>
          <div className="big">{fmtUsd(status.equity)}</div>
        </div>
        <div className="card stat">
          <div className="muted small">Cash available</div>
          <div className="big">{fmtUsd(status.usdAvailable)}</div>
        </div>
        <div className="card stat">
          <div className="muted small">Today P&L</div>
          <div className={'big ' + pnlClass(status.pnlToday)}>{fmtSignedUsd(status.pnlToday)}</div>
          <div className={'muted small ' + pnlClass(status.pnlTodayPct)}>{fmtPct(status.pnlTodayPct)}</div>
        </div>
        <div className="card stat">
          <div className="muted small">Day started at</div>
          <div className="big">{fmtUsd(status.dayStartEquity)}</div>
        </div>
      </section>

      <section className="card">
        <div className="row spread">
          <div>
            <div className="h2">Risk:reward slider</div>
            <div className="muted small">Adjusts the take-profit distance only. Position size and stop-loss stay risk-capped.</div>
          </div>
          <div className="big">{bitmap.riskReward.toFixed(1)}x</div>
        </div>
        <input
          className="slider"
          type="range"
          min={bitmap.riskRewardMin ?? 0.5}
          max={bitmap.riskRewardMax ?? 3}
          step={0.1}
          value={bitmap.riskReward}
          onChange={(e) => props.onRiskSlider(Number(e.target.value))}
        />
        <div className="row muted small">
          <span>conservative {(bitmap.riskRewardMin ?? 0.5).toFixed(1)}</span>
          <span>aggressive {(bitmap.riskRewardMax ?? 3).toFixed(1)}</span>
        </div>
      </section>

      <section className="card">
        <div className="h2">Open positions ({positions.length})</div>
        {positions.length === 0 && <div className="muted">No open positions. The bot enters automatically when its setup fires.</div>}
        <PositionsList positions={positions} />
      </section>

      {props.perf !== null && (
        <section className="card">
          <div className="h2">Performance</div>
          <div className="row2">
            <div className="stat">
              <div className="muted small">Win rate</div>
              <div className="big">{props.perf.winRate === null ? '-' : (props.perf.winRate * 100).toFixed(0) + '%'}</div>
            </div>
            <div className="stat">
              <div className="muted small">Profit factor</div>
              <div className="big">{props.perf.profitFactor === null ? '-' : props.perf.profitFactor.toFixed(2)}</div>
            </div>
            <div className="stat">
              <div className="muted small">Max drawdown</div>
              <div className="big">{fmtUsd(props.perf.maxDrawdown)}</div>
            </div>
            <div className="stat">
              <div className="muted small">Fees paid</div>
              <div className="big">{fmtUsd(props.perf.feesPaid)}</div>
            </div>
          </div>
          {props.perf.equityCurve.length > 2 && <Sparkline values={props.perf.equityCurve} />}
          <div className="muted small">{props.perf.trades} closed trades</div>
        </section>
      )}

      <button
        className="danger big-btn"
        onClick={() => {
          if (confirmStop) {
            props.onEmergencyStop()
            setConfirmStop(false)
          } else {
            setConfirmStop(true)
          }
        }}
      >
        {confirmStop ? 'Tap again to cancel all orders, close everything, halt' : 'EMERGENCY STOP ALL'}
      </button>
      <div className="muted small">Last scan: {status.lastScanAt ? fmtTime(status.lastScanAt * 1) : '-'}</div>
    </div>
  )
}

function PositionsList(props: { positions: Position[] }): JSX.Element {
  return (
    <div>
      {props.positions.map((p) => (
        <div className="position" key={p.id}>
          <div className="row spread">
            <div>
              <div className="h3">{p.symbol.toUpperCase()} long</div>
              <div className="muted small">
                {fmtQty(p.remainingQty)} @ entry {fmtPrice(p.entry)} - {p.kind}
              </div>
            </div>
            <div className={'right ' + pnlClass(p.unrealizedPnl)}>
              <div className="big">{fmtSignedUsd(p.unrealizedPnl)}</div>
              <div className="muted small">now {p.currentPrice === null ? '-' : fmtPrice(p.currentPrice)}</div>
            </div>
          </div>
          <div className="row muted small">
            <span>stop {fmtPrice(p.stop)}</span>
            <span>target {fmtPrice(p.target)}</span>
            <span>risk {fmtUsd(p.riskUsd)}</span>
            {p.breakevenDone && <span className="ok-text">breakeven done</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

export function Watchlist(props: { prices: Record<string, SymbolTick> }): JSX.Element {
  const entries = Object.entries(props.prices)
  return (
    <div className="page">
      <div className="h2">Watchlist</div>
      {entries.length === 0 && <div className="muted">Waiting for live prices...</div>}
      <div className="card list">
        {entries.map(([symbol, tick]) => (
          <div className="row spread item" key={symbol}>
            <div className="h3">{symbol.toUpperCase()}</div>
            <div className="big">{fmtPrice(tick.price)}</div>
            <div className="muted small">{fmtTime(tick.at)}</div>
          </div>
        ))}
      </div>
      <div className="muted small">Prices stream live over WebSocket from Gemini market data.</div>
    </div>
  )
}
