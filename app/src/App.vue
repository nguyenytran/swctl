<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoute } from 'vue-router'
import GitHubAuthButton from '@/components/GitHubAuthButton.vue'
import { useInstances } from '@/composables/useInstances'
import { useProjects } from '@/composables/useProjects'
import { useActiveProject } from '@/composables/useActiveProject'

const route = useRoute()
const { refresh: refreshInstances } = useInstances()
const { refresh: refreshProjects } = useProjects()
const { activeProjectName, setProject, ensureSelection, projects } = useActiveProject()

onMounted(async () => {
  await refreshProjects()
  ensureSelection()
  refreshInstances()
})
</script>

<template>
  <div class="min-h-screen bg-surface-dark text-gray-200 font-mono">
    <header class="border-b border-border px-6 py-4 flex items-center justify-between">
      <div class="flex items-center gap-6">
        <h1 class="text-lg font-bold tracking-tight text-white">swctl</h1>
        <nav class="flex gap-1">
          <router-link
            to="/dashboard"
            class="px-3 py-1 text-sm rounded transition-colors"
            :class="route.path.startsWith('/dashboard')
              ? 'bg-surface text-white'
              : 'text-gray-500 hover:text-gray-300'"
          >Dashboard</router-link>
          <router-link
            to="/worktrees"
            class="px-3 py-1 text-sm rounded transition-colors"
            :class="route.path.startsWith('/worktrees')
              ? 'bg-surface text-white'
              : 'text-gray-500 hover:text-gray-300'"
          >Worktrees</router-link>
        </nav>
        <div v-if="projects.length > 0" class="flex items-center gap-2 ml-2 border-l border-border pl-4">
          <span class="text-xs text-gray-500">Project:</span>
          <select
            :value="activeProjectName"
            @change="setProject(($event.target as HTMLSelectElement).value)"
            class="bg-surface border border-border rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500 cursor-pointer"
          >
            <option value="">All projects</option>
            <option v-for="p in projects" :key="p.name" :value="p.name">{{ p.name }}</option>
          </select>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <GitHubAuthButton />
        <span class="text-xs text-gray-500">worktree manager</span>
      </div>
    </header>
    <main class="max-w-7xl mx-auto px-4 py-6">
      <router-view />
    </main>
  </div>
</template>
