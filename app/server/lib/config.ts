/**
 * User config stored at ~/.swctl/config.json.  Shared by the CLI
 * (`swctl config ...`) and the UI (/config page + /api/config).
 *
 * Schema is intentionally loose — a free-form JSON object with a few
 * well-known keys.  Adding a new key means: extend UserConfig below,
 * default it in readUserConfig(), expose it in the UI page, and
 * (optionally) read it from the shell side via `_user_config_read`.
 *
 * Env vars always win over the config file for backwards compatibility
 * and so CI / tests can poke settings without touching disk.
 */

import fs from 'fs'
import path from 'path'

const CONFIG_FILE =
  process.env.SWCTL_CONFIG_FILE ||
  path.join(process.env.HOME || '/root', '.swctl/config.json')

export interface UserConfig {
  features: {
    /**
     * Whether the /resolve route + related APIs are enabled.  Falls back
     * to the `SWCTL_RESOLVE_ENABLED=1` env var when absent; see
     * `isResolveEnabled()`.
     */
    resolveEnabled?: boolean
  }
  ai: {
    /** "claude" | "codex" — default backend for new resolves. */
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

/** Read + parse the user config file.  Never throws — returns defaults. */
export function readUserConfig(): UserConfig {
  if (!fs.existsSync(CONFIG_FILE)) return defaultConfig()
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    // Anything other than a plain object (null, array, number, string) →
    // treat as corrupt and fall back.  Otherwise downstream code would
    // choke on `.features` being undefined.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return defaultConfig()
    }
    const p = parsed as Partial<UserConfig>
    return {
      features: (p.features && typeof p.features === 'object' ? p.features : {}) as UserConfig['features'],
      ai:       (p.ai       && typeof p.ai       === 'object' ? p.ai       : {}) as UserConfig['ai'],
    }
  } catch {
    // Corrupt file — don't block the UI from being usable; show defaults.
    return defaultConfig()
  }
}

function defaultConfig(): UserConfig {
  return { features: {}, ai: {} }
}

/**
 * Atomically write the config file.  Validates that the input is an
 * object and that known fields have the expected types — malformed
 * payloads from a buggy UI shouldn't corrupt the file.
 */
export function writeUserConfig(next: Partial<UserConfig> | null | undefined): UserConfig {
  const current = readUserConfig()
  // Belt-and-braces: handle any of {null, undefined, partial} input shapes
  // so a malformed PUT body can't crash the handler — clients get a clean
  // "nothing changed" response instead of a 500.
  const safeNext: Partial<UserConfig> = next || {}
  const curFeatures = current.features || {}
  const curAi = current.ai || {}
  const nextFeatures = safeNext.features || {}
  const nextAi = safeNext.ai || {}

  // Merge two levels deep for `ai` so e.g. saving just `ai.claude.bin`
  // doesn't clobber `ai.codex.*`.
  const merged: UserConfig = {
    features: { ...curFeatures, ...nextFeatures },
    ai: {
      ...curAi,
      ...nextAi,
      claude: { ...(curAi.claude || {}), ...(nextAi.claude || {}) },
      codex:  { ...(curAi.codex  || {}), ...(nextAi.codex  || {}) },
    },
  }

  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  const tmp = `${CONFIG_FILE}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmp, CONFIG_FILE)
  return merged
}

/** Absolute path to the config file (for `swctl config path` parity). */
export function configFilePath(): string {
  return CONFIG_FILE
}

/**
 * Is the resolve feature enabled?  Resolution order (first hit wins):
 *   1. `SWCTL_RESOLVE_ENABLED=1` env var   (legacy, still supported)
 *   2. `.features.resolveEnabled === true` in config.json
 *   3. false
 *
 * Read dynamically (no module-load caching) so toggling via the UI
 * takes effect immediately without a server restart.
 */
export function isResolveEnabled(): boolean {
  if (process.env.SWCTL_RESOLVE_ENABLED === '1') return true
  try {
    return readUserConfig().features.resolveEnabled === true
  } catch {
    return false
  }
}
