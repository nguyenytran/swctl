<script setup lang="ts">
import type { Instance } from '@/types'

defineProps<{ instance: Instance; selected: boolean }>()
const emit = defineEmits<{
  delete: []
  retry: []
  setup: []
  manage: []
  stop: []
  start: []
  'switch-mode': [mode: string]
  'toggle-select': []
}>()

function statusColor(status: string) {
  if (status === 'running') return 'text-emerald-400'
  if (status === 'exited') return 'text-yellow-400'
  return 'text-gray-500'
}

function modeLabel(mode: string) {
  return mode === 'qa' ? 'QA' : 'Dev'
}

function typeLabel(type: string) {
  if (type === 'plugin-embedded') return 'Plugin (embed)'
  if (type === 'plugin-external') return 'Plugin (ext)'
  return 'Platform'
}

function formatDate(iso: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function provisionBadge(status: string) {
  if (status === 'creating') return { text: 'Creating', cls: 'bg-blue-500/20 text-blue-400 border-blue-500/30' }
  if (status === 'failed') return { text: 'Failed', cls: 'bg-red-500/20 text-red-400 border-red-500/30' }
  return null
}
</script>

<template>
  <tr class="border-t border-border hover:bg-surface-hover transition-colors" :class="{ 'opacity-60': instance.status === 'creating' }">
    <td class="px-4 py-3 w-8">
      <input
        type="checkbox"
        :checked="selected"
        @change="emit('toggle-select')"
        @click.stop
        class="accent-blue-500 cursor-pointer"
      />
    </td>
    <td class="px-4 py-3 font-medium text-white cursor-pointer hover:text-blue-400 transition-colors" @click="emit('manage')">
      {{ instance.issue || instance.issueId }}
      <span v-if="instance.pluginName" class="ml-1 text-xs text-purple-400">{{ instance.pluginName }}</span>
      <span
        v-if="provisionBadge(instance.status)"
        class="ml-2 text-[10px] px-1.5 py-0.5 rounded border"
        :class="provisionBadge(instance.status)!.cls"
      >
        {{ provisionBadge(instance.status)!.text }}
      </span>
    </td>
    <td class="px-4 py-3 text-gray-400 max-w-[200px] truncate" :title="instance.branch">
      {{ instance.branch || '—' }}
      <span v-if="instance.checkedOut" class="ml-1 text-[10px] px-1.5 py-0.5 rounded border border-orange-500/40 text-orange-400 bg-orange-500/10">checked out</span>
    </td>
    <td class="px-4 py-3">
      <button
        v-if="instance.status === 'complete'"
        class="text-xs px-2 py-0.5 rounded border transition-colors"
        :class="instance.mode === 'qa'
          ? 'border-orange-500/40 text-orange-400 hover:bg-orange-500/10'
          : 'border-blue-500/40 text-blue-400 hover:bg-blue-500/10'"
        @click="emit('switch-mode', instance.mode === 'qa' ? 'dev' : 'qa')"
        :title="`Switch to ${instance.mode === 'qa' ? 'dev' : 'qa'} mode`"
      >
        {{ modeLabel(instance.mode) }}
      </button>
      <span v-else class="text-xs text-gray-600">—</span>
    </td>
    <td class="px-4 py-3 text-xs text-gray-400">
      {{ typeLabel(instance.projectType) }}
    </td>
    <td class="px-4 py-3">
      <template v-if="instance.status === 'complete'">
        <span class="inline-flex items-center gap-1.5 text-xs" :class="statusColor(instance.containerStatus)">
          <span class="w-1.5 h-1.5 rounded-full" :class="{
            'bg-emerald-400': instance.containerStatus === 'running',
            'bg-yellow-400': instance.containerStatus === 'exited',
            'bg-gray-500': instance.containerStatus === 'missing',
          }"></span>
          {{ instance.containerStatus }}
        </span>
      </template>
      <span v-else class="text-xs text-gray-600">—</span>
    </td>
    <td class="px-4 py-3">
      <div v-if="instance.status === 'complete'" class="flex items-center gap-2">
        <a
          v-if="instance.appUrl"
          :href="instance.appUrl"
          target="_blank"
          class="text-blue-400 hover:text-blue-300 transition-colors"
          title="Open Store"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </a>
        <a
          v-if="instance.appUrl"
          :href="instance.appUrl + '/admin'"
          target="_blank"
          class="text-purple-400 hover:text-purple-300 transition-colors"
          title="Open Admin"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>
        </a>
      </div>
      <span v-else class="text-gray-600 text-xs">—</span>
    </td>
    <td class="px-4 py-3 text-xs text-gray-500">
      {{ formatDate(instance.createdAt) }}
    </td>
    <td class="px-4 py-3 text-right space-x-2">
      <template v-if="instance.status === 'failed' || instance.status === 'creating'">
        <button
          class="text-xs text-blue-400 hover:text-blue-300 transition-colors"
          @click="emit('retry')"
          title="Retry provisioning"
        >
          Retry
        </button>
        <button
          class="text-xs text-red-400 hover:text-red-300 transition-colors"
          @click="emit('delete')"
          title="Delete worktree"
        >
          Delete
        </button>
      </template>
      <template v-else-if="instance.containerStatus === 'missing'">
        <button
          class="text-xs text-blue-400 hover:text-blue-300 transition-colors"
          @click="emit('setup')"
          title="Provision database and container"
        >
          Setup
        </button>
        <button
          class="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
          @click="emit('retry')"
          title="Refresh from remote"
        >
          Refresh
        </button>
        <button
          class="text-xs text-red-400 hover:text-red-300 transition-colors"
          @click="emit('delete')"
          title="Delete worktree"
        >
          Delete
        </button>
      </template>
      <template v-else>
        <button
          v-if="instance.containerStatus === 'running'"
          class="text-xs text-yellow-400 hover:text-yellow-300 transition-colors"
          @click="emit('stop')"
          title="Stop container"
        >
          Stop
        </button>
        <button
          v-if="instance.containerStatus === 'exited'"
          class="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
          @click="emit('start')"
          title="Start container"
        >
          Start
        </button>
        <button
          class="text-xs text-red-400 hover:text-red-300 transition-colors"
          @click="emit('delete')"
          title="Delete worktree"
        >
          Delete
        </button>
      </template>
    </td>
  </tr>
</template>
