// Quantity/price rounding against exchange step sizes.

export function floorToStep(value: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return value
  return Math.floor(value / step + 1e-9) * step
}

export function climbToStep(value: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return value
  return Math.ceil(value / step - 1e-9) * step
}

export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 8
  const s = step.toString()
  if (s.includes('e-')) return Number(s.split('e-')[1])
  const dot = s.indexOf('.')
  return dot === -1 ? 0 : s.length - dot - 1
}

export function fmtQty(value: number, step: number): string {
  return value.toFixed(decimalsOf(step))
}

export function fmtUsd(value: number): string {
  return value.toFixed(2)
}
