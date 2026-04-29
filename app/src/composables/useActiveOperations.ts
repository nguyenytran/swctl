/**
 * Reactive list of long-running operations the server is currently
 * driving (creates, cleans, refreshes, etc.).  Backed by:
 *
 *   - GET /api/operations   one-shot snapshot at first mount
 *   - GET /api/events       live updates via stream-start /
 *                           stream-progress / stream-done
 *
 * Single shared list across all consumers (like useEvents).  The bar
 * component subscribes; navigation between routes doesn't lose state.
 *
 * Design note: we keep `useEvents` as the single EventSource owner —
 * `useActiveOperations` watches `lastEvent` instead of opening a
 * second EventSource.  Two reasons: (1) browsers cap EventSource
 * connections per origin (typically 6); (2) the existing pubsub
 * already fans events out to multiple watchers.
 */
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { useEvents, type ServerEvent } from './useEvents'

export interface ActiveOperation {
  streamId: string
  kind: string         // 'create' | 'clean' | 'refresh' | 'switch' | 'logs' | 'exec' | 'checkout'
  issueId: string
  step: number         // 0..total
  stepName: string
  total: number        // 5 for create, 0 for ops without step markers
  startedAt: number    // epoch ms
}

// Single shared reactive list, populated lazily on first composable
// instantiation.  Subsequent consumers share the same list.
const operations = ref<ActiveOperation[]>([])
let initialized = false
let unwatch: (() => void) | null = null

async function fetchSnapshot(): Promise<void> {
  try {
    const res = await fetch('/api/operations')
    if (!res.ok) return
    const body = await res.json() as { operations?: ActiveOperation[] }
    operations.value = body.operations || []
  } catch {
    // Best-effort; the events stream catches up missing snapshots.
  }
}

function applyEvent(ev: ServerEvent): void {
  if (!ev || !ev.type || !ev.streamId) return

  if (ev.type === 'stream-start') {
    // Fetch the fresh snapshot — the start event doesn't carry the
    // full operation shape (kind/issueId/startedAt come from the
    // server's bookkeeping which only /api/operations exposes).
    void fetchSnapshot()
    return
  }

  if (ev.type === 'stream-progress') {
    const idx = operations.value.findIndex((o) => o.streamId === ev.streamId)
    if (idx >= 0) {
      operations.value[idx] = {
        ...operations.value[idx],
        step: ev.step ?? operations.value[idx].step,
        stepName: ev.stepName ?? operations.value[idx].stepName,
      }
    } else {
      // Missed the stream-start (e.g., reconnect after a brief
      // disconnect) — re-fetch the snapshot and the next event will
      // catch up.
      void fetchSnapshot()
    }
    return
  }

  if (ev.type === 'stream-done') {
    operations.value = operations.value.filter((o) => o.streamId !== ev.streamId)
    return
  }
}

export function useActiveOperations() {
  const { lastEvent } = useEvents()

  // Initialise once across the whole app — every consumer shares
  // the same `operations` ref.
  onMounted(async () => {
    if (initialized) return
    initialized = true
    await fetchSnapshot()
    unwatch = watch(lastEvent, (ev) => {
      if (ev) applyEvent(ev)
    })
  })

  onUnmounted(() => {
    // We deliberately DON'T un-initialise on the last unmount — the
    // operations list is meant to track app-wide state.  If the last
    // consumer goes away we just stop having anyone read the list,
    // and the next mount picks up where we left off.
    void unwatch  // suppress unused warning; intentionally not called
  })

  return { operations }
}
