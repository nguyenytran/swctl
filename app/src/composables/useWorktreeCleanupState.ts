import { ref, computed, watch } from 'vue'
import { fetchCleanupStateBatch, type CleanupState } from '@/api'
import { useEvents } from './useEvents'

const BATCH_LIMIT = 25

/**
 * Per-row cleanup metadata for the /worktrees page: disk size, last activity,
 * git dirty / ahead-behind, and linked-PR state. The backend caches for 5
 * minutes; this composable caches in-memory until the next `instance-changed`
 * SSE event (then it clears so the next page visit re-fetches).
 */
export function useWorktreeCleanupState() {
  const cache = ref<Record<string, CleanupState>>({})
  const loading = ref(false)
  const { lastEvent } = useEvents()

  watch(lastEvent, (ev) => {
    if (ev?.type === 'instance-changed') {
      cache.value = {}
    }
  })

  const inFlight = new Set<string>()

  async function refreshAll(issueIds: string[]): Promise<void> {
    // Only fetch ids we don't already have and aren't already fetching.
    // Without this, every keystroke in the search box would re-hit the
    // backend for the same worktrees, stacking up `du` calls.
    const missing = issueIds.filter((id) => !cache.value[id] && !inFlight.has(id))
    if (missing.length === 0) return
    for (const id of missing) inFlight.add(id)
    loading.value = true
    try {
      // Chunk to respect the server's BATCH_LIMIT.
      for (let i = 0; i < missing.length; i += BATCH_LIMIT) {
        const slice = missing.slice(i, i + BATCH_LIMIT)
        const batch = await fetchCleanupStateBatch(slice)
        cache.value = { ...cache.value, ...batch }
      }
    } finally {
      for (const id of missing) inFlight.delete(id)
      loading.value = false
    }
  }

  function stateFor(issueId: string): CleanupState | null {
    return cache.value[issueId] || null
  }

  const hasAny = computed(() => Object.keys(cache.value).length > 0)

  return { stateFor, refreshAll, loading, hasAny }
}
