import { ref } from 'vue'
import type { ResolveRun, PrInfo, PrCreatePreview } from '@/api/resolve'
import { fetchResolveRuns, fetchPrInfo, fetchPrCreatePreview, prAction as prActionApi } from '@/api/resolve'

const runs = ref<ResolveRun[]>([])
const loading = ref(false)

export function useResolve() {
  async function refresh() {
    loading.value = true
    try {
      runs.value = await fetchResolveRuns()
    } catch {
      runs.value = []
    } finally {
      loading.value = false
    }
  }

  async function getPr(issueId: string): Promise<PrInfo> {
    return fetchPrInfo(issueId)
  }

  async function prAction(
    issueId: string,
    action: 'push' | 'create' | 'merge' | 'approve' | 'ready',
    overrides?: { title?: string; body?: string; baseBranch?: string },
  ) {
    return prActionApi(issueId, action, overrides)
  }

  async function getPrCreatePreview(issueId: string): Promise<PrCreatePreview> {
    return fetchPrCreatePreview(issueId)
  }

  return { runs, loading, refresh, getPr, getPrCreatePreview, prAction }
}
