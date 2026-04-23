import { ref } from 'vue'

/**
 * Server-exposed feature flags.  Default to all-off until `/api/features`
 * resolves — components gate conditional UI on these booleans so a disabled
 * feature's UI never renders (nav, route, action buttons, etc.).
 *
 * The module-scope `features` ref is shared across every component that
 * imports it, so the single server fetch populates the whole app.
 */
export interface Features {
  resolveEnabled: boolean
}

const features = ref<Features>({ resolveEnabled: false })
let loaded = false
let inflight: Promise<void> | null = null

/**
 * Fetch (or refetch) /api/features.  `force=true` bypasses the one-shot
 * cache — used by ConfigPage after the user toggles a flag so the nav
 * + router pick up the new state without a full page reload.
 */
async function load(force = false): Promise<void> {
  if (loaded && !force) return
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch('/api/features')
      if (res.ok) {
        const json = (await res.json()) as Partial<Features>
        features.value = {
          resolveEnabled: !!json.resolveEnabled,
        }
      }
    } catch {
      // Leave defaults (all-off) if the endpoint is unreachable — safer
      // than accidentally showing a gated feature.
    } finally {
      loaded = true
      inflight = null
    }
  })()
  return inflight
}

// Kick the fetch off once at module load.  Components that need the flags
// early can `await loadFeatures()`; most can just read `features.value.*`
// after the first tick.
void load()

export function useFeatures() {
  return {
    features,
    loadFeatures: load,
  }
}
