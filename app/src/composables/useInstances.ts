import { ref, computed } from 'vue'
import type { Instance, ExternalWorktree, WorktreeItem } from '@/types'
import { isExternalWorktree } from '@/types'
import { fetchInstances } from '@/api'
import { useActiveProject } from './useActiveProject'

const allItems = ref<WorktreeItem[]>([])
const loading = ref(false)

export function useInstances() {
  const { activeProjectName } = useActiveProject()

  async function refresh() {
    loading.value = true
    try {
      allItems.value = await fetchInstances()
    } finally {
      loading.value = false
    }
  }

  const instances = computed(() =>
    allItems.value.filter((i): i is Instance & { kind?: 'managed' } => !isExternalWorktree(i)) as Instance[]
  )

  const externalWorktrees = computed(() =>
    allItems.value.filter((i): i is ExternalWorktree => isExternalWorktree(i))
  )

  // Project-filtered versions
  const filteredInstances = computed(() =>
    activeProjectName.value
      ? instances.value.filter(i => i.projectSlug === activeProjectName.value)
      : instances.value
  )

  const filteredExternalWorktrees = computed(() =>
    activeProjectName.value
      ? externalWorktrees.value.filter(w => w.projectSlug === activeProjectName.value || !w.registered)
      : externalWorktrees.value
  )

  function grouped(): Record<string, Instance[]> {
    const map: Record<string, Instance[]> = {}
    for (const inst of filteredInstances.value) {
      const key = inst.projectSlug || 'unknown'
      ;(map[key] ??= []).push(inst)
    }
    return map
  }

  return {
    instances,
    externalWorktrees,
    filteredInstances,
    filteredExternalWorktrees,
    loading,
    refresh,
    grouped,
  }
}
