<script setup lang="ts">
import { ref, onMounted } from 'vue'
import Dashboard from '@/components/Dashboard.vue'
import WorktreeOverview from '@/components/WorktreeOverview.vue'
import { useInstances } from '@/composables/useInstances'
import { useProjects } from '@/composables/useProjects'

const { refresh: refreshInstances } = useInstances()
const { refresh: refreshProjects } = useProjects()
const activeView = ref<'dashboard' | 'overview'>('dashboard')

onMounted(() => {
  refreshInstances()
  refreshProjects()
})
</script>

<template>
  <div class="min-h-screen bg-surface-dark text-gray-200 font-mono">
    <header class="border-b border-border px-6 py-4 flex items-center justify-between">
      <div class="flex items-center gap-6">
        <h1 class="text-lg font-bold tracking-tight text-white">swctl</h1>
        <nav class="flex gap-1">
          <button
            class="px-3 py-1 text-sm rounded transition-colors"
            :class="activeView === 'dashboard'
              ? 'bg-surface text-white'
              : 'text-gray-500 hover:text-gray-300'"
            @click="activeView = 'dashboard'"
          >Dashboard</button>
          <button
            class="px-3 py-1 text-sm rounded transition-colors"
            :class="activeView === 'overview'
              ? 'bg-surface text-white'
              : 'text-gray-500 hover:text-gray-300'"
            @click="activeView = 'overview'"
          >Worktrees</button>
        </nav>
      </div>
      <span class="text-xs text-gray-500">worktree manager</span>
    </header>
    <main class="max-w-7xl mx-auto px-4 py-6">
      <Dashboard v-if="activeView === 'dashboard'" />
      <WorktreeOverview v-else />
    </main>
  </div>
</template>
