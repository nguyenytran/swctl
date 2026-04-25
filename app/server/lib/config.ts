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

/**
 * Backends swctl knows how to spawn for the resolve workflow.  Add a new
 * one here, then teach `_ai_*` (bash) and `buildSpawnArgs` (TS) about it.
 *
 * Exported as a const tuple so the validators / UI can iterate without
 * duplicating the list.
 */
export const KNOWN_BACKENDS = ['claude', 'codex'] as const
export type KnownBackend = typeof KNOWN_BACKENDS[number]

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
    /**
     * Default backend for new resolves.  MUST be one of `enabledBackends`
     * (validated on PUT — caller gets a 400 if not).  Selecting in the
     * resolve form's AI dropdown overrides this per-issue, but only
     * within the enabled set.
     */
    defaultBackend?: KnownBackend
    /**
     * Subset of `KNOWN_BACKENDS` the user has opted into.  An empty/missing
     * list defaults to `['claude']` for back-compat with pre-redesign
     * configs that only had `defaultBackend`.  Resolve UI's backend
     * dropdown only shows these values.
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

/**
 * Resolve which backends are enabled, applying the back-compat default
 * when the field is missing.  Centralised so every reader (server,
 * plugin via the API response, tests) agrees on the rule:
 *
 *   - explicit non-empty list → use it (de-duped, filtered to known)
 *   - missing OR empty        → ['claude']  (the pre-redesign default)
 *   - includes only unknown   → ['claude']  (defensive — config is
 *                                            recoverable rather than
 *                                            "no backends" deadlock)
 */
export function resolveEnabledBackends(config: UserConfig): KnownBackend[] {
  const raw = config.ai?.enabledBackends ?? []
  const filtered = raw.filter((b): b is KnownBackend => (KNOWN_BACKENDS as readonly string[]).includes(b))
  // Dedupe while preserving first-occurrence order — set semantics, but
  // the order users picked in the UI is meaningful for "first enabled" fallbacks.
  const seen = new Set<KnownBackend>()
  const out: KnownBackend[] = []
  for (const b of filtered) if (!seen.has(b)) { seen.add(b); out.push(b) }
  return out.length > 0 ? out : ['claude']
}

/**
 * Resolve the effective default backend, applying the
 * "must-be-enabled" invariant.  Returns the first enabled backend
 * when defaultBackend is missing OR refers to a now-disabled backend
 * (which can happen if the user disabled their default-of-record without
 * picking a new one — be forgiving rather than throwing).
 */
export function resolveDefaultBackend(config: UserConfig): KnownBackend {
  const enabled = resolveEnabledBackends(config)
  const def = config.ai?.defaultBackend
  if (def && enabled.includes(def)) return def
  return enabled[0]   // resolveEnabledBackends guarantees length ≥ 1
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
 * Shallow-copy an object with every `undefined` value dropped.
 *
 * This is the crux of writeUserConfig's merge correctness: a spread
 * `{...current, ...next}` where `next.someKey === undefined` DOES
 * overwrite `current.someKey` with undefined.  Then `JSON.stringify`
 * drops the key on write, and the next read treats the field as unset.
 *
 * That pattern caused a user-reported regression where saving
 * "switch default backend to Codex" in the /config UI silently turned
 * `features.resolveEnabled: true` → missing (because the sanitizer
 * in the PUT handler produced `features: { resolveEnabled: undefined }`
 * when the UI payload had no features key).  Stripping undefineds
 * BEFORE the merge means "unspecified" correctly means "keep current."
 */
function stripUndefined<T extends object>(o: T | undefined | null): Partial<T> {
  if (!o) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (v !== undefined) out[k] = v
  }
  return out as Partial<T>
}

/**
 * Atomically write the config file.  Validates that the input is an
 * object and that known fields have the expected types — malformed
 * payloads from a buggy UI shouldn't corrupt the file.
 *
 * Merge semantics: the caller sends a Partial<UserConfig>.  Every
 * key that's PRESENT in the partial wins; every key that's ABSENT
 * (including those set to `undefined`) preserves the on-disk value.
 * This lets the UI save just `ai.defaultBackend` without clobbering
 * `features.resolveEnabled` or `ai.claude.bin`.
 */
export function writeUserConfig(next: Partial<UserConfig> | null | undefined): UserConfig {
  const current = readUserConfig()
  const safeNext: Partial<UserConfig> = next || {}
  const curFeatures = current.features || {}
  const curAi = current.ai || {}
  const nextFeatures = stripUndefined(safeNext.features)
  const nextAi = stripUndefined(safeNext.ai)
  const curAiClaude = curAi.claude || {}
  const curAiCodex  = curAi.codex  || {}
  // stripUndefined on the nested objects so a sanitizer that emits
  // `claude: { bin: undefined, configDir: undefined }` doesn't wipe
  // the existing values.
  const nextAiClaude = stripUndefined((safeNext.ai || {}).claude)
  const nextAiCodex  = stripUndefined((safeNext.ai || {}).codex)

  // Merge two levels deep for `ai` so e.g. saving just `ai.defaultBackend`
  // doesn't clobber `ai.claude.*` or `ai.codex.*`.  `stripUndefined`
  // at every level keeps "absent key" distinct from "set to undefined."
  //
  // `enabledBackends` is an array — overwrite-on-supply, preserve-on-absent.
  // (We don't union-merge: if the user unticks a backend in the UI,
  // the resulting array MUST replace the on-disk list, not merge with it.)
  const merged: UserConfig = {
    features: { ...curFeatures, ...nextFeatures },
    ai: {
      ...curAi,
      ...nextAi,
      claude: { ...curAiClaude, ...nextAiClaude },
      codex:  { ...curAiCodex,  ...nextAiCodex  },
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
 * Pre-write validation of the AI section.  Checks the cross-field
 * invariants that read-time fallbacks would happily paper over but the
 * user probably didn't intend.  Returns null if OK, an error message if
 * not.
 *
 * Rules:
 *  - If `enabledBackends` is supplied, it must be a non-empty array.
 *    "no backends" is a misconfiguration that breaks the resolve flow.
 *  - Every entry of `enabledBackends` must be a known backend.
 *  - If `defaultBackend` is supplied, it must be in `enabledBackends`
 *    (or, when `enabledBackends` isn't supplied in this PUT, in the
 *    on-disk effective list — we read it via resolveEnabledBackends
 *    so a partial save doesn't pin to a stale list).
 *
 * Called by the PUT handler before writeUserConfig so a 400 reaches the
 * UI with an actionable message; the writer itself stays terse.
 */
export function validateAiConfig(
  next: Partial<UserConfig> | null | undefined,
  current: UserConfig,
): string | null {
  const ai = next?.ai
  if (!ai) return null

  if (ai.enabledBackends !== undefined) {
    if (!Array.isArray(ai.enabledBackends) || ai.enabledBackends.length === 0) {
      return 'enabledBackends must be a non-empty array (at least one backend has to be on, otherwise the resolve flow has nothing to spawn)'
    }
    for (const b of ai.enabledBackends) {
      if (!(KNOWN_BACKENDS as readonly string[]).includes(b)) {
        return `enabledBackends contains unknown backend "${b}"; allowed: ${KNOWN_BACKENDS.join(', ')}`
      }
    }
  }

  if (ai.defaultBackend !== undefined) {
    if (!(KNOWN_BACKENDS as readonly string[]).includes(ai.defaultBackend)) {
      return `defaultBackend "${ai.defaultBackend}" is not a known backend; allowed: ${KNOWN_BACKENDS.join(', ')}`
    }
    // Build the effective enabled list as it would be POST-merge:
    // explicit incoming list wins, otherwise fall back to current.
    const effective = ai.enabledBackends ?? resolveEnabledBackends(current)
    if (!effective.includes(ai.defaultBackend)) {
      return `defaultBackend "${ai.defaultBackend}" must be one of enabledBackends (${effective.join(', ')})`
    }
  }

  return null
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
