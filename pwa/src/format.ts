// Formatting helpers shared by every screen.

export function fmtUsd(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-'
  return '$' + v.toFixed(digits)
}

export function fmtSignedUsd(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-'
  const sign = v >= 0 ? '+' : ''
  return sign + '$' + v.toFixed(digits)
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-'
  const sign = v >= 0 ? '+' : ''
  return sign + v.toFixed(digits) + '%'
}

export function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-'
  if (Math.abs(v) >= 1000) return v.toFixed(0)
  if (Math.abs(v) >= 1) return v.toFixed(2)
  return v.toFixed(4)
}

export function fmtQty(v: number): string {
  const s = String(v.toPrecision(6))
  return s.includes('e') ? String(Number(s)) : s
}

export function fmtTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return '-'
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function fmtDateTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return '-'
  return new Date(ts).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })
}

export function pnlClass(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return ''
  return v >= 0 ? 'pos' : 'neg'
}
