// UTC time helpers. All daily accounting uses UTC day keys.

export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export function utcHour(now: Date): number {
  return now.getUTCHours()
}

export function utcMinute(now: Date): number {
  return now.getUTCMinutes()
}

// True within the first N minutes of every hour (right after the 1h candle close).
export function inQuietMinutes(now: Date, quietMinutes: number): boolean {
  return utcMinute(now) < quietMinutes
}

// True inside the low-volume window, e.g. hours [2, 6) UTC.
export function inLowVolumeWindow(now: Date, hours: [number, number]): boolean {
  const h = utcHour(now)
  return h >= hours[0] && h < hours[1]
}

export function isoOf(ms: number): string {
  return new Date(ms).toISOString()
}

// Window bucket used to limit setups per symbol per rolling 4 hours.
export function bucket4h(ms: number): string {
  return dayKey(new Date(ms)) + ':' + String(Math.floor(ms / (4 * 3600 * 1000)))
}
