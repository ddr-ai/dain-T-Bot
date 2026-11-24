// REST client for the backend. Set VITE_API_BASE at build time when the
// API runs on a different origin (defaults to same origin, works from the
// dev proxy and from a bundled static host behind the same domain).

const BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = localStorage.getItem('apiToken')
  if (token && token.length > 0) h['Authorization'] = 'Bearer ' + token
  return h
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers ?? {}) }
  })
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error !== undefined) msg = body.error
    } catch {
      /* keep default */
    }
    throw new Error(msg)
  }
  return (await res.json()) as T
}

export const api = {
  status: (): Promise<import('./types.ts').Status> => j('/api/status'),
  activity: (limit = 80): Promise<import('./types.ts').Activity[]> => j('/api/activity?limit=' + limit),
  trades: (limit = 50): Promise<import('./types.ts').Trade[]> => j('/api/trades?limit=' + limit),
  performance: (): Promise<import('./types.ts').Performance> => j('/api/performance'),
  settings: (): Promise<import('./types.ts').Settings> => j('/api/settings'),
  correlations: (): Promise<Record<string, number>> => j('/api/correlations'),
  setAutopilot: (enabled: boolean) =>
    j('/api/autopilot', { method: 'POST', body: JSON.stringify({ enabled }) }),
  updateSettings: (patch: Record<string, unknown>) =>
    j('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  saveCredentials: (key: string, secret: string) =>
    j('/api/credentials', { method: 'POST', body: JSON.stringify({ key, secret }) }),
  deleteCredentials: () => j('/api/credentials', { method: 'DELETE' }),
  emergencyStop: () => j('/api/emergency-stop', { method: 'POST' }),
  setToken: (token: string): void => {
    if (token.length > 0) localStorage.setItem('apiToken', token)
    else localStorage.removeItem('apiToken')
  },
  getToken: (): string => localStorage.getItem('apiToken') ?? ''
}

export function baseUrl(): string {
  return BASE || window.location.origin
}
