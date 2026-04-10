import { ref } from 'vue'
import type { Instance } from '@/types'
import { fetchInstances } from '@/api'

const instances = ref<Instance[]>([])
const loading = ref(false)

export function useInstances() {
  async function refresh() {
    loading.value = true
    try {
      instances.value = await fetchInstances()
    } finally {
      loading.value = false
    }
  }

  function grouped(): Record<string, Instance[]> {
    const map: Record<string, Instance[]> = {}
    for (const inst of instances.value) {
      const key = inst.projectSlug || 'unknown'
      ;(map[key] ??= []).push(inst)
    }
    return map
  }

  return { instances, loading, refresh, grouped }
}
