// Inline SVG equity-curve sparkline (no chart library needed).

export function Sparkline(props: { values: number[] }): JSX.Element {
  const { values } = props
  const w = 320
  const h = 72
  if (values.length < 2) return <div className="muted small">not enough data for a curve</div>
  const min = Math.min(...values, 0)
  const max = Math.max(...values, 0.0001)
  const span = max - min || 1
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w
    const y = h - ((v - min) / span) * h
    return x.toFixed(1) + ',' + y.toFixed(1)
  })
  const last = values[values.length - 1]
  const area = '0,' + h + ' ' + pts.join(' ') + ' ' + w + ',' + h
  return (
    <svg className="spark" viewBox={'0 0 ' + w + ' ' + h} role="img" aria-label="equity curve">
      <polygon points={area} fill={last >= 0 ? 'rgba(34,211,238,0.15)' : 'rgba(248,113,113,0.15)'} />
      <polyline points={pts.join(' ')} fill="none" stroke={last >= 0 ? '#22d3ee' : '#f87171'} strokeWidth="2" />
    </svg>
  )
}
