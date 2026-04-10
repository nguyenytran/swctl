<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useInstances } from '@/composables/useInstances'
import { useProjects } from '@/composables/useProjects'
import { useStream } from '@/composables/useStream'
import InstanceRow from './InstanceRow.vue'
import CreateModal from './CreateModal.vue'
import ProjectsModal from './ProjectsModal.vue'
import LogPanel from './LogPanel.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import InstanceDetail from './InstanceDetail.vue'
import { buildStreamUrl, stopInstance, startInstance } from '@/api'
import type { Instance } from '@/types'

const { instances, loading, refresh, grouped } = useInstances()
const { projects } = useProjects()
const stream = useStream()

const showCreate = ref(false)
const showProjects = ref(false)
const confirmAction = ref<{ title: string; message: string; onConfirm: () => void } | null>(null)
const selectedInstance = ref<Instance | null>(null)

const groupedInstances = computed(() => grouped())
const hasInstances = computed(() => instances.value.length > 0)

function handleDelete(issueId: string, hasPlugins: boolean) {
  confirmAction.value = {
    title: 'Delete Worktree',
    message: `Delete worktree "${issueId}"?${hasPlugins ? ' This has linked plugins and will use --force.' : ''}`,
    onConfirm: () => {
      const params: Record<string, string> = { issueId }
      if (hasPlugins) params.force = '1'
      stream.start(buildStreamUrl('clean', params))
      confirmAction.value = null
    },
  }
}

function handleSwitchMode(issueId: string, mode: string) {
  stream.start(buildStreamUrl('switch-mode', { issueId, mode }))
}

function handleRetry(issueId: string) {
  stream.start(buildStreamUrl('refresh', { issueId }))
}

async function handleStop(issueId: string) {
  await stopInstance(issueId)
  refresh()
}

async function handleStart(issueId: string) {
  await startInstance(issueId)
  refresh()
}

function handleManage(inst: Instance) {
  selectedInstance.value = inst
}

function onStreamDone() {
  refresh()
}

// Auto-refresh when any stream completes (create, delete, switch-mode, refresh)
watch(() => stream.result.value, (val) => {
  if (val) refresh()
})
</script>

<template>
  <div>
    <!-- Actions bar -->
    <div class="flex items-center gap-3 mb-6">
      <button
        class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition-colors"
        @click="showCreate = true"
      >
        + Create
      </button>
      <button
        class="px-4 py-2 bg-surface hover:bg-surface-hover text-gray-300 text-sm rounded border border-border transition-colors"
        @click="showProjects = true"
      >
        Projects
      </button>
      <button
        class="px-3 py-2 bg-surface hover:bg-surface-hover text-gray-400 text-sm rounded border border-border transition-colors"
        :class="{ 'animate-spin': loading }"
        @click="refresh()"
        title="Refresh"
      >
        ↻
      </button>
      <span v-if="loading" class="text-xs text-gray-500">Loading…</span>
    </div>

    <!-- Log panel (shown when streaming) -->
    <LogPanel
      v-if="stream.running.value || stream.result.value"
      :lines="stream.lines.value"
      :running="stream.running.value"
      :result="stream.result.value"
      @close="stream.stop(); onStreamDone()"
    />

    <!-- Instances table grouped by project -->
    <div v-if="hasInstances" class="border border-border rounded-lg overflow-hidden">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-surface text-gray-400 text-xs uppercase tracking-wider">
            <th class="text-left px-4 py-3">Issue</th>
            <th class="text-left px-4 py-3">Branch</th>
            <th class="text-left px-4 py-3">Mode</th>
            <th class="text-left px-4 py-3">Type</th>
            <th class="text-left px-4 py-3">Status</th>
            <th class="text-left px-4 py-3">Links</th>
            <th class="text-left px-4 py-3">Created</th>
            <th class="text-right px-4 py-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="(items, project) in groupedInstances" :key="project">
            <tr class="bg-surface-dark border-t border-border">
              <td colspan="8" class="px-4 py-2 text-xs font-bold text-gray-500 uppercase tracking-widest">
                {{ project }}
              </td>
            </tr>
            <InstanceRow
              v-for="inst in items"
              :key="inst.issueId"
              :instance="inst"
              @delete="handleDelete(inst.issueId, inst.linkedPlugins.length > 0)"
              @retry="handleRetry(inst.issueId)"
              @switch-mode="handleSwitchMode(inst.issueId, $event)"
              @stop="handleStop(inst.issueId)"
              @start="handleStart(inst.issueId)"
              @manage="handleManage(inst)"
            />
          </template>
        </tbody>
      </table>
    </div>

    <!-- Empty state -->
    <div v-else-if="!loading" class="text-center py-16 text-gray-500">
      <p class="text-lg mb-2">No worktrees</p>
      <p class="text-sm">Click <strong>+ Create</strong> to get started.</p>
    </div>

    <!-- Modals -->
    <CreateModal v-if="showCreate" @close="showCreate = false" @created="showCreate = false; refresh()" :stream="stream" />
    <ProjectsModal v-if="showProjects" @close="showProjects = false" />
    <ConfirmDialog v-if="confirmAction" v-bind="confirmAction" @cancel="confirmAction = null" />

    <!-- Instance detail slide-over -->
    <InstanceDetail
      v-if="selectedInstance"
      :instance="selectedInstance"
      @close="selectedInstance = null"
      @refresh="refresh()"
    />
  </div>
</template>
