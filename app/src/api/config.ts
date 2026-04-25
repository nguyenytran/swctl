/**
 * Thin client for GET/PUT /api/user-config + the test-cli probe.
 * Mirrors the server-side UserConfig shape in
 * `app/server/lib/config.ts` — keep them in sync.
 */

export type KnownBackend = 'claude' | 'codex'
export const KNOWN_BACKENDS: readonly KnownBackend[] = ['claude', 'codex'] as const

export interface UserConfig {
  features: {
    resolveEnabled?: boolean
  }
  ai: {
    /** Default backend — must be one of `enabledBackends`. */
    defaultBackend?: KnownBackend
    /**
     * Subset of KNOWN_BACKENDS the user has opted into.  Resolve UI's
     * AI dropdown only renders these.  Missing/empty falls back to
     * ['claude'] — the back-compat default.
     */
    enabledBackends?: KnownBackend[]
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
  /**
   * Resolved values with back-compat defaults applied.  Use these
   * instead of re-deriving from `config.ai.enabledBackends` /
   * `config.ai.defaultBackend` on the client.
   */
  resolved: {
    enabledBackends: KnownBackend[]
    defaultBackend: KnownBackend
  }
}

export interface TestCliResult {
  ok: boolean
  /** Path/name of the binary the server actually probed. */
  bin: string
  /** First line of `<bin> --version` stdout (or stderr if stdout was empty). */
  version?: string
  /** Failure reason — ENOENT, timeout, non-zero exit, etc. */
  error?: string
}

export interface TestSkillResult {
  ok: boolean
  backend: KnownBackend
  /** Absolute path the server-side check inspected. */
  location: string
  /** Human-readable detail (size + name on success, what's missing on failure). */
  detail: string
  /** Failure reason — null on success. */
  error?: string
}

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

/**
 * Smoke-test a backend's CLI: spawns `<bin> --version` with a 5s
 * timeout and returns the result.  Used by the /#/config page's
 * "Test" buttons so the user can pre-flight check whether the
 * binary is on PATH inside the swctl-ui container.
 */
export async function testCli(backend: KnownBackend): Promise<TestCliResult> {
  const res = await fetch(`${USER_CONFIG_URL}/test-cli?backend=${encodeURIComponent(backend)}`)
  // 400 (unknown backend) returns a TestCliResult-shaped body too,
  // so we don't throw — let the UI surface the error inline.
  return res.json()
}

/**
 * Skill-install pre-flight check.  Static — no spawn.  Confirms the
 * shopware-resolve skill is installed where the backend will look:
 *   - claude: ~/.claude/skills/shopware-resolve/SKILL.md
 *   - codex:  swctl marker block in ~/.codex/AGENTS.md
 */
export async function testSkill(backend: KnownBackend): Promise<TestSkillResult> {
  const res = await fetch(`${USER_CONFIG_URL}/test-skill?backend=${encodeURIComponent(backend)}`)
  return res.json()
}
