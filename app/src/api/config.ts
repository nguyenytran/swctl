/**
 * Thin client for GET/PUT /api/config.  Mirrors the server-side
 * UserConfig shape in app/server/lib/config.ts — keep them in sync.
 */

export interface UserConfig {
  features: {
    resolveEnabled?: boolean
  }
  ai: {
    defaultBackend?: 'claude' | 'codex'
    claude?: {
      bin?: string
      configDir?: string
    }
    codex?: {
      bin?: string
      configDir?: string
    }
  }
}

export interface ConfigResponse {
  path: string
  config: UserConfig
}

// `/api/user-config` — NOT `/api/config`, because the latter is already
// bound to the Shopware project config (.swctl.conf) reader.
const USER_CONFIG_URL = '/api/user-config'

export async function fetchConfig(): Promise<ConfigResponse> {
  const res = await fetch(USER_CONFIG_URL)
  if (!res.ok) throw new Error(`Failed to load config (${res.status})`)
  return res.json()
}

export async function saveConfig(config: UserConfig): Promise<ConfigResponse> {
  const res = await fetch(USER_CONFIG_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `Failed to save config (${res.status})`)
  }
  return res.json()
}
