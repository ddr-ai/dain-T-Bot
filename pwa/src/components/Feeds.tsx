import type { Activity, Trade } from '../types.ts'
import { fmtDateTime, fmtPrice, fmtQty, fmtSignedUsd, pnlClass } from '../format.ts'

const KIND_LABEL: Record<string, string> = {
  enter: 'ENTER',
  exit: 'EXIT',
  skip: 'skip',
  stop: 'stop move',
  breaker: 'BREAKER',
  emergency: 'EMERGENCY',
  engine: 'engine',
  error: 'ERROR',
  protect: 'protect',
  security: 'security'
}

export function ActivityFeed(props: { items: Activity[] }): JSX.Element {
  return (
    <div className="page">
      <div className="h2">Activity feed</div>
      <div className="muted small">Everything the bot did and why - entries placed, stops moved, exits hit, and skips with reasons.</div>
      <div className="card list">
        {props.items.length === 0 && <div className="muted">No activity yet. Turn on Autopilot and watch this fill up.</div>}
        {props.items.map((a, i) => (
          <div className="item small" key={a.ts + '-' + i}>
            <div className="row">
              <span className="muted">{fmtDateTime(a.ts)}</span>
              <span className="tag">{KIND_LABEL[a.kind] ?? a.kind}</span>
            </div>
            <div>{a.msg}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function TradesList(props: { trades: Trade[] }): JSX.Element {
  return (
    <div className="page">
      <div className="h2">Trade history</div>
      <div className="card list">
        {props.trades.length === 0 && <div className="muted">No trades yet.</div>}
        {props.trades.map((t) => (
          <div className="item" key={t.id}>
            <div className="row spread">
              <div>
                <div className="h3">
                  {t.symbol.toUpperCase()} <span className="muted small">({t.kind})</span>
                </div>
                <div className="muted small">
                  {fmtQty(t.qty)} in @ {fmtPrice(t.entry)} {'->'} {t.exit === null ? 'open' : 'out @ ' + fmtPrice(t.exit)}
                </div>
              </div>
              <div className={'right ' + pnlClass(t.pnlUsd)}>
                <div className="big">{fmtSignedUsd(t.pnlUsd)}</div>
                <div className="muted small">{t.exitReason ?? (t.status === 'open' ? 'running' : '-')}</div>
              </div>
            </div>
            <div className="row muted small">
              <span>{t.mode}</span>
              <span>fees {t.feesUsd.toFixed(2)}</span>
              <span>{t.status === 'open' ? 'opened ' + fmtDateTime(t.openedAt) : 'closed ' + fmtDateTime(t.closedAt)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
