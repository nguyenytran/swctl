<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useInstances } from '@/composables/useInstances'
import { useProjects } from '@/composables/useProjects'
import { useStream } from '@/composables/useStream'
import InstanceRow from './InstanceRow.vue'
import CreateModal from './CreateModal.vue'
import BatchCreateModal from './BatchCreateModal.vue'
import BatchDeleteModal from './BatchDeleteModal.vue'
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
const showBatchCreate = ref(false)
const showBatchDelete = ref(false)
const batchDeleteInstances = ref<Instance[]>([])
const showProjects = ref(false)
const confirmAction = ref<{ title: string; message: string; onConfirm: () => void } | null>(null)
const selectedInstance = ref<Instance | null>(null)
const selected = ref<Set<string>>(new Set())

const groupedInstances = computed(() => grouped())
const hasInstances = computed(() => instances.value.length > 0)

// All instance IDs (flattened from grouped)
const allInstanceIds = computed(() => instances.value.map(i => i.issueId))

function toggleSelect(id: string) {
  const s = new Set(selected.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  selected.value = s
}

function toggleAll() {
  if (selected.value.size === allInstanceIds.value.length) {
    selected.value = new Set()
  } else {
    selected.value = new Set(allInstanceIds.value)
  }
}

async function bulkStop() {
  for (const id of selected.value) {
    await stopInstance(id)
  }
  selected.value = new Set()
  refresh()
}

async function bulkStart() {
  for (const id of selected.value) {
    await startInstance(id)
  }
  selected.value = new Set()
  refresh()
}

function bulkDelete() {
  const ids = Array.from(selected.value)
  const toDelete = instances.value.filter(i => ids.includes(i.issueId))
  if (toDelete.length === 0) return

  confirmAction.value = {
    title: 'Delete Selected',
    message: `Delete ${toDelete.length} worktree(s)? This cannot be undone.`,
    onConfirm: () => {
      batchDeleteInstances.value = toDelete
      showBatchDelete.value = true
      selected.value = new Set()
      confirmAction.value = null
    },
  }
}

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
        class="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded transition-colors"
        @click="showBatchCreate = true"
      >
        + Batch
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

    <!-- Bulk actions bar -->
    <div v-if="selected.size > 0" class="flex items-center gap-3 mb-4 bg-surface border border-border rounded-lg px-4 py-2">
      <span class="text-sm text-gray-400">{{ selected.size }} selected</span>
      <button
        class="text-xs px-2 py-1 bg-emerald-600/20 text-emerald-400 border border-emerald-600/30 rounded hover:bg-emerald-600/30 transition-colors"
        @click="bulkStart"
      >Start</button>
      <button
        class="text-xs px-2 py-1 bg-yellow-600/20 text-yellow-400 border border-yellow-600/30 rounded hover:bg-yellow-600/30 transition-colors"
        @click="bulkStop"
      >Stop</button>
      <button
        class="text-xs px-2 py-1 bg-red-600/20 text-red-400 border border-red-600/30 rounded hover:bg-red-600/30 transition-colors"
        @click="bulkDelete"
      >Delete</button>
      <button
        class="text-xs text-gray-500 hover:text-gray-300 ml-auto transition-colors"
        @click="selected = new Set()"
      >Clear</button>
    </div>

    <!-- Instances table grouped by project -->
    <div v-if="hasInstances" class="border border-border rounded-lg overflow-hidden">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-surface text-gray-400 text-xs uppercase tracking-wider">
            <th class="px-4 py-3 w-8">
              <input
                type="checkbox"
                :checked="selected.size === allInstanceIds.length && allInstanceIds.length > 0"
                @change="toggleAll"
                class="accent-blue-500 cursor-pointer"
              />
            </th>
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
              <td colspan="9" class="px-4 py-2 text-xs font-bold text-gray-500 uppercase tracking-widest">
                {{ project }}
              </td>
            </tr>
            <InstanceRow
              v-for="inst in items"
              :key="inst.issueId"
              :instance="inst"
              :selected="selected.has(inst.issueId)"
              @toggle-select="toggleSelect(inst.issueId)"
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
    <BatchCreateModal v-if="showBatchCreate" @close="showBatchCreate = false" @refresh="refresh()" />
    <BatchDeleteModal v-if="showBatchDelete" :instances="batchDeleteInstances" @close="showBatchDelete = false" @refresh="refresh()" />
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
