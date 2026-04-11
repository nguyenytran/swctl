<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useInstances } from '@/composables/useInstances'
import { useActiveProject } from '@/composables/useActiveProject'
import { useStream } from '@/composables/useStream'
import { buildStreamUrl, stopInstance, startInstance } from '@/api'
import type { Instance } from '@/types'
import LogPanel from './LogPanel.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import BatchCreateModal from './BatchCreateModal.vue'
import BatchDeleteModal from './BatchDeleteModal.vue'

const route = useRoute()
const router = useRouter()

const { filteredInstances, loading, refresh } = useInstances()
const { activeProjectName } = useActiveProject()
const stream = useStream()

const showBatchCreate = computed(() => route.meta.modal === 'batch-create')
const showBatchDelete = ref(false)
const batchDeleteInstances = ref<Instance[]>([])
const search = ref('')
const filterProject = ref('')
const filterStatus = ref('')
const selected = ref<Set<string>>(new Set())
const copiedId = ref('')
const confirmAction = ref<{ title: string; message: string; onConfirm: () => void } | null>(null)

onMounted(() => {
  refresh()
})

// Unique project slugs for filter dropdown
const projectSlugs = computed(() => {
  const slugs = new Set(filteredInstances.value.map(i => i.projectSlug).filter(Boolean))
  return Array.from(slugs).sort()
})

// Filtered instances
const filtered = computed(() => {
  let list = filteredInstances.value
  if (search.value) {
    const q = search.value.toLowerCase()
    list = list.filter(i =>
      i.issue.toLowerCase().includes(q) ||
      i.issueId.toLowerCase().includes(q) ||
      i.branch.toLowerCase().includes(q) ||
      i.projectSlug.toLowerCase().includes(q) ||
      (i.pluginName && i.pluginName.toLowerCase().includes(q))
    )
  }
  if (filterProject.value) {
    list = list.filter(i => i.projectSlug === filterProject.value)
  }
  if (filterStatus.value) {
    list = list.filter(i => {
      if (filterStatus.value === 'running') return i.containerStatus === 'running'
      if (filterStatus.value === 'stopped') return i.containerStatus === 'exited'
      if (filterStatus.value === 'failed') return i.status === 'failed'
      return true
    })
  }
  return list
})

// Stats
const stats = computed(() => {
  const all = filteredInstances.value
  return {
    total: all.length,
    running: all.filter(i => i.containerStatus === 'running').length,
    stopped: all.filter(i => i.containerStatus === 'exited').length,
    failed: all.filter(i => i.status === 'failed').length,
  }
})

function toggleSelect(id: string) {
  const s = new Set(selected.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  selected.value = s
}

function toggleAll() {
  if (selected.value.size === filtered.value.length) {
    selected.value = new Set()
  } else {
    selected.value = new Set(filtered.value.map(i => i.issueId))
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
  const toDelete = filteredInstances.value.filter(i => ids.includes(i.issueId))
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


function handleDelete(inst: Instance) {
  const force = inst.linkedPlugins.length > 0
  confirmAction.value = {
    title: 'Delete Worktree',
    message: `Delete "${inst.issueId}"?${force ? ' This has linked plugins and will use --force.' : ''}`,
    onConfirm: () => {
      const params: Record<string, string> = { issueId: inst.issueId }
      if (force) params.force = '1'
      stream.start(buildStreamUrl('clean', params))
      confirmAction.value = null
    },
  }
}

async function handleStop(inst: Instance) {
  await stopInstance(inst.issueId)
  refresh()
}

async function handleStart(inst: Instance) {
  await startInstance(inst.issueId)
  refresh()
}

function statusDot(inst: Instance) {
  if (inst.status === 'failed') return 'bg-red-400'
  if (inst.containerStatus === 'running') return 'bg-emerald-400'
  if (inst.containerStatus === 'exited') return 'bg-yellow-400'
  return 'bg-gray-500'
}

function formatDate(iso: string) {
  if (!iso) return '--'
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Auto-refresh on stream done
import { watch } from 'vue'
watch(() => stream.result.value, (val) => {
  if (val) refresh()
})
</script>

<template>
  <div>
    <!-- Stats cards -->
    <div class="grid grid-cols-4 gap-4 mb-6">
      <div class="bg-surface border border-border rounded-lg px-4 py-3">
        <div class="text-2xl font-bold text-white">{{ stats.total }}</div>
        <div class="text-xs text-gray-500 uppercase tracking-wider">Total</div>
      </div>
      <div class="bg-surface border border-border rounded-lg px-4 py-3">
        <div class="text-2xl font-bold text-emerald-400">{{ stats.running }}</div>
        <div class="text-xs text-gray-500 uppercase tracking-wider">Running</div>
      </div>
      <div class="bg-surface border border-border rounded-lg px-4 py-3">
        <div class="text-2xl font-bold text-yellow-400">{{ stats.stopped }}</div>
        <div class="text-xs text-gray-500 uppercase tracking-wider">Stopped</div>
      </div>
      <div class="bg-surface border border-border rounded-lg px-4 py-3">
        <div class="text-2xl font-bold text-red-400">{{ stats.failed }}</div>
        <div class="text-xs text-gray-500 uppercase tracking-wider">Failed</div>
      </div>
    </div>

    <!-- Filters & bulk actions -->
    <div class="flex items-center gap-3 mb-4">
      <button
        class="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded transition-colors shrink-0"
        @click="router.push('/worktrees/batch-create')"
      >
        + Batch
      </button>
      <input
        v-model="search"
        type="text"
        placeholder="Search issues, branches, projects..."
        class="flex-1 bg-surface border border-border rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500 transition-colors"
      />
      <select
        v-model="filterProject"
        class="bg-surface border border-border rounded px-3 py-2 text-sm text-gray-300 outline-none"
      >
        <option value="">All projects</option>
        <option v-for="slug in projectSlugs" :key="slug" :value="slug">{{ slug }}</option>
      </select>
      <select
        v-model="filterStatus"
        class="bg-surface border border-border rounded px-3 py-2 text-sm text-gray-300 outline-none"
      >
        <option value="">All statuses</option>
        <option value="running">Running</option>
        <option value="stopped">Stopped</option>
        <option value="failed">Failed</option>
      </select>
      <button
        class="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors"
        :class="{ 'animate-spin': loading }"
        @click="refresh()"
        title="Refresh"
      >&#8635;</button>
    </div>

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

    <!-- Log panel -->
    <LogPanel
      v-if="stream.running.value || stream.result.value"
      :lines="stream.lines.value"
      :running="stream.running.value"
      :result="stream.result.value"
      @close="stream.stop(); refresh()"
    />

    <!-- Card grid -->
    <div v-if="filtered.length" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      <div
        v-for="inst in filtered"
        :key="inst.issueId"
        class="bg-surface border rounded-lg overflow-hidden transition-colors"
        :class="selected.has(inst.issueId) ? 'border-blue-500' : 'border-border hover:border-gray-600'"
      >
        <!-- Card header -->
        <div class="px-4 py-3 flex items-start justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <input
              type="checkbox"
              :checked="selected.has(inst.issueId)"
              @change="toggleSelect(inst.issueId)"
              class="shrink-0 accent-blue-500"
            />
            <span class="w-2 h-2 rounded-full shrink-0" :class="statusDot(inst)"></span>
            <div class="min-w-0">
              <div class="text-white font-medium text-sm truncate">
                {{ inst.issue || inst.issueId }}
                <span v-if="inst.pluginName" class="text-purple-400 text-xs ml-1">{{ inst.pluginName }}</span>
              </div>
              <div class="text-xs text-gray-500 truncate" :title="inst.branch">{{ inst.branch || 'no branch' }}</div>
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <span
              class="text-[10px] px-1.5 py-0.5 rounded border"
              :class="inst.mode === 'qa'
                ? 'border-orange-500/40 text-orange-400'
                : 'border-blue-500/40 text-blue-400'"
            >{{ inst.mode === 'qa' ? 'QA' : 'Dev' }}</span>
            <span class="text-[10px] px-1.5 py-0.5 rounded border border-border text-gray-500">
              {{ inst.projectSlug }}
            </span>
          </div>
        </div>

        <!-- Card body -->
        <div class="px-4 pb-2">
          <div
            v-if="inst.worktreePath"
            class="text-[11px] font-mono text-gray-500 truncate mb-2"
            :title="inst.worktreePath"
          >{{ inst.worktreePath }}</div>
          <div class="text-[11px] text-gray-600">{{ formatDate(inst.createdAt) }}</div>
        </div>

        <!-- Card actions -->
        <div class="border-t border-border px-4 py-2 flex items-center gap-2">
          <a
            v-if="inst.appUrl && inst.status === 'complete'"
            :href="inst.appUrl"
            target="_blank"
            class="text-blue-400 hover:text-blue-300 transition-colors"
            title="Open Store"
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </a>
          <a
            v-if="inst.appUrl && inst.status === 'complete'"
            :href="inst.appUrl + '/admin'"
            target="_blank"
            class="text-purple-400 hover:text-purple-300 transition-colors"
            title="Open Admin"
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>
          </a>

          <div class="ml-auto flex items-center gap-2">
            <button
              v-if="inst.status === 'complete' && inst.containerStatus === 'exited'"
              class="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
              @click="handleStart(inst)"
            >Start</button>
            <button
              v-if="inst.status === 'complete' && inst.containerStatus === 'running'"
              class="text-xs text-yellow-400 hover:text-yellow-300 transition-colors"
              @click="handleStop(inst)"
            >Stop</button>
            <button
              class="text-xs text-red-400 hover:text-red-300 transition-colors"
              @click="handleDelete(inst)"
            >Delete</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div v-else-if="!loading" class="text-center py-16 text-gray-500">
      <p v-if="filteredInstances.length === 0" class="text-lg mb-2">No worktrees</p>
      <p v-else class="text-lg mb-2">No worktrees match your filters</p>
    </div>

    <!-- Select all toggle -->
    <div v-if="filtered.length" class="mt-4 flex items-center gap-2">
      <button
        class="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        @click="toggleAll"
      >{{ selected.size === filtered.length ? 'Deselect all' : 'Select all' }}</button>
    </div>

    <ConfirmDialog v-if="confirmAction" v-bind="confirmAction" @cancel="confirmAction = null" />
    <BatchCreateModal v-if="showBatchCreate" @close="router.push('/worktrees')" @refresh="refresh()" />
    <BatchDeleteModal v-if="showBatchDelete" :instances="batchDeleteInstances" @close="showBatchDelete = false" @refresh="refresh()" />
  </div>
</template>
