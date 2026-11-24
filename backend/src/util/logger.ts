// Timestamped console logger with levels.
// IMPORTANT invariant: never pass credentials or raw signed payloads here.

function ts(): string {
  return new Date().toISOString()
}

function emit(level: string, msg: string, data?: unknown): void {
  const line = '[' + ts() + '] [' + level + '] ' + msg
  if (data !== undefined) {
    const safe = typeof data === 'string' ? data : safeJson(data)
    console.log(line + ' ' + safe)
  } else {
    console.log(line)
  }
}

function safeJson(data: unknown): string {
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}

export const log = {
  info: (msg: string, data?: unknown) => emit('INFO', msg, data),
  warn: (msg: string, data?: unknown) => emit('WARN', msg, data),
  error: (msg: string, data?: unknown) => emit('ERROR', msg, data),
  debug: (msg: string, data?: unknown) => {
    if (process.env.LOG_LEVEL === 'debug') emit('DEBUG', msg, data)
  }
}
