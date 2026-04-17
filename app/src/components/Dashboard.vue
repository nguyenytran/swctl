<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useInstances } from '@/composables/useInstances'
import { useProjects } from '@/composables/useProjects'
import { useStream } from '@/composables/useStream'
import { useEvents } from '@/composables/useEvents'
import InstanceRow from './InstanceRow.vue'
import BatchCreateModal from './BatchCreateModal.vue'
import BatchDeleteModal from './BatchDeleteModal.vue'
import ProjectsModal from './ProjectsModal.vue'
import LogPanel from './LogPanel.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import InstanceDetail from './InstanceDetail.vue'
import PluginSlot from './PluginSlot.vue'
import { usePlugins } from '@/composables/usePlugins'
import { buildStreamUrl, buildCreateUrl, stopInstance, startInstance, setupInstance, linkExternalWorktree, buildRefreshExternalUrl, addProject } from '@/api'
import type { Instance, ExternalWorktree } from '@/types'

const route = useRoute()
const router = useRouter()

const { filteredInstances, filteredExternalWorktrees, instances, loading, loaded: instancesLoaded, refresh, grouped } = useInstances()
const { projects } = useProjects()
const stream = useStream()
const { lastEvent } = useEvents()
const plugins = usePlugins()

// Plugin widgets split by slot location
const sidebarWidgets = computed(() => plugins.widgets.value.filter(w => w.location === 'dashboard-sidebar'))
const bottomWidgets = computed(() => plugins.widgets.value.filter(w => w.location === 'dashboard-bottom'))

// Route-driven modal state
const showBatchCreate = computed(() => route.meta.modal === 'batch-create')
const showProjects = computed(() => route.meta.modal === 'projects')
const routeInstanceId = computed(() => route.meta.modal === 'instance' ? route.params.issueId as string : null)

// Non-route modal state (batch delete needs instance data, confirm is transient)
const showBatchDelete = ref(false)
const batchDeleteInstances = ref<Instance[]>([])
const confirmAction = ref<{ title: string; message: string; onConfirm: () => void } | null>(null)
const selected = ref<Set<string>>(new Set())

// Link issue state
const linkingWorktree = ref<ExternalWorktree | null>(null)
const linkIssueId = ref('')

// Resolve instance from route param
const selectedInstance = computed(() => {
  if (!routeInstanceId.value) return null
  return instances.value.find(i => i.issueId === routeInstanceId.value) || null
})

const groupedInstances = computed(() => grouped())
const hasInstances = computed(() => filteredInstances.value.length > 0 || filteredExternalWorktrees.value.length > 0)

// All instance IDs (flattened from grouped, filtered)
const allInstanceIds = computed(() => filteredInstances.value.map(i => i.issueId))

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

async function handleSetup(issueId: string) {
  // Set STATUS=creating so swctl refresh does full provisioning
  const res = await setupInstance(issueId)
  if (!res.ok) return
  stream.start(buildStreamUrl('refresh', { issueId }))
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
  router.push(`/dashboard/instance/${inst.issueId}`)
}

// External worktree actions
function startLinkIssue(wt: ExternalWorktree) {
  linkingWorktree.value = wt
  linkIssueId.value = ''
}

async function submitLinkIssue() {
  if (!linkingWorktree.value || !linkIssueId.value.trim()) return
  const wt = linkingWorktree.value
  const res = await linkExternalWorktree({
    worktreePath: wt.worktreePath,
    issueId: linkIssueId.value.trim(),
    project: wt.projectSlug,
  })
  linkingWorktree.value = null
  linkIssueId.value = ''
  if (res.ok) refresh()
}

function cancelLinkIssue() {
  linkingWorktree.value = null
  linkIssueId.value = ''
}

async function registerProject(wt: ExternalWorktree) {
  if (!wt.repoPath) return
  const name = wt.repoPath.split('/').pop() || wt.projectSlug
  const res = await addProject({ name, path: wt.repoPath, type: 'platform' })
  if (res.ok) refresh()
}

function refreshExternal(wt: ExternalWorktree) {
  stream.start(buildRefreshExternalUrl(wt.worktreePath, wt.projectSlug))
}

// Adopt external plugin worktree (create full environment)
const adoptingWorktree = ref<ExternalWorktree | null>(null)
const adoptIssueId = ref('')

function startAdopt(wt: ExternalWorktree) {
  adoptingWorktree.value = wt
  adoptIssueId.value = ''
}

function cancelAdopt() {
  adoptingWorktree.value = null
  adoptIssueId.value = ''
}

function submitAdopt() {
  if (!adoptingWorktree.value || !adoptIssueId.value.trim()) return
  const wt = adoptingWorktree.value
  const url = buildCreateUrl({
    issue: adoptIssueId.value.trim(),
    mode: 'dev',
    project: wt.parentProject || '',
    plugin: wt.pluginName || '',
    adoptWorktreePath: wt.worktreePath,
  })
  stream.start(url)
  adoptingWorktree.value = null
  adoptIssueId.value = ''
}

function onStreamDone() {
  refresh()
}

// Auto-refresh when any stream completes (create, delete, switch-mode, refresh)
watch(() => stream.result.value, (val) => {
  if (val) refresh()
})

// Auto-refresh when MCP or external actions modify instances (via event bus)
watch(lastEvent, (event) => {
  if (event?.type === 'instance-changed') refresh()
})

// Re-fetch on mount so navigating here from another route (e.g. from
// the /resolve plugin page after a run just finished) always shows the
// latest instances without a manual page reload.
onMounted(() => { refresh() })

// If the user lands on /dashboard/instance/<id> for an instance we haven't
// loaded yet (e.g. just-created), refresh so the detail view can render it.
watch(() => route.params.issueId, (id) => {
  if (id && !instances.value.find(i => i.issueId === id)) refresh()
})
</script>

<template>
  <div>
    <!-- Actions bar -->
    <div class="flex items-center gap-3 mb-6">
      <button
        class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition-colors"
        @click="router.push('/dashboard/batch-create')"
      >
        + Create
      </button>
      <button
        class="px-4 py-2 bg-surface hover:bg-surface-hover text-gray-300 text-sm rounded border border-border transition-colors"
        @click="router.push('/dashboard/projects')"
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

    <!-- Instances area — render a reserved-space skeleton while the
         initial /api/instances is in flight so the content below
         doesn't jump up once data arrives. -->
    <div
      v-if="!instancesLoaded"
      class="border border-border rounded-lg bg-surface min-h-[180px] animate-pulse opacity-40"
      aria-hidden="true"
    />
    <!-- Instances table grouped by project -->
    <div v-else-if="filteredInstances.length > 0" class="border border-border rounded-lg overflow-hidden">
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
              @setup="handleSetup(inst.issueId)"
              @switch-mode="handleSwitchMode(inst.issueId, $event)"
              @stop="handleStop(inst.issueId)"
              @start="handleStart(inst.issueId)"
              @manage="handleManage(inst)"
            />
          </template>
        </tbody>
      </table>
    </div>

    <!-- External worktrees (Claude Code, Codex, manual) -->
    <div v-if="filteredExternalWorktrees.length > 0" class="border border-dashed border-border rounded-lg overflow-hidden" :class="{ 'mt-4': filteredInstances.length > 0 }">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-surface text-gray-500 text-xs uppercase tracking-wider">
            <th class="text-left px-4 py-2">Path</th>
            <th class="text-left px-4 py-2">Branch</th>
            <th class="text-left px-4 py-2">Source</th>
            <th class="text-left px-4 py-2">Project</th>
            <th class="text-left px-4 py-2">HEAD</th>
            <th class="text-right px-4 py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="wt in filteredExternalWorktrees"
            :key="wt.worktreePath"
            class="border-t border-border hover:bg-surface-hover transition-colors"
          >
            <td class="px-4 py-2.5 font-mono text-xs text-gray-300 truncate max-w-xs" :title="wt.worktreePath">
              {{ wt.worktreePath.replace(/.*\//, '') || wt.worktreePath }}
            </td>
            <td class="px-4 py-2.5 text-xs">
              <span v-if="wt.branch" class="text-white font-mono">{{ wt.branch }}</span>
              <span v-else class="text-gray-600 italic">(detached)</span>
            </td>
            <td class="px-4 py-2.5">
              <span
                class="text-[10px] px-1.5 py-0.5 rounded font-medium"
                :class="{
                  'bg-purple-600/20 text-purple-400 border border-purple-600/30': wt.source === 'claude',
                  'bg-cyan-600/20 text-cyan-400 border border-cyan-600/30': wt.source === 'codex',
                  'bg-blue-600/20 text-blue-400 border border-blue-600/30': wt.source === 'swctl',
                  'bg-gray-600/20 text-gray-400 border border-gray-600/30': wt.source === 'manual',
                }"
              >{{ wt.source === 'claude' ? 'Claude' : wt.source === 'codex' ? 'Codex' : wt.source === 'swctl' ? 'swctl' : 'Manual' }}</span>
            </td>
            <td class="px-4 py-2.5 text-xs text-gray-500">
              <template v-if="wt.isPlugin">
                <span class="text-gray-400">{{ wt.pluginName }}</span>
                <span class="text-gray-600"> / {{ wt.projectSlug }}</span>
              </template>
              <template v-else>{{ wt.projectSlug }}</template>
            </td>
            <td class="px-4 py-2.5 text-xs font-mono text-gray-600">{{ wt.head?.slice(0, 7) }}</td>
            <td class="px-4 py-2.5 text-right whitespace-nowrap">
              <!-- Adopt plugin worktree inline form -->
              <template v-if="adoptingWorktree?.worktreePath === wt.worktreePath">
                <div class="inline-flex items-center gap-1">
                  <input
                    v-model="adoptIssueId"
                    type="text"
                    placeholder="Issue ID (e.g. NEXT-12345)"
                    class="bg-surface-dark border border-border rounded px-2 py-0.5 text-xs text-white w-40 focus:outline-none focus:border-emerald-500"
                    @keyup.enter="submitAdopt"
                    @keyup.escape="cancelAdopt"
                  />
                  <button
                    @click="submitAdopt"
                    :disabled="!adoptIssueId.trim()"
                    class="text-[10px] px-1.5 py-0.5 bg-emerald-600/20 text-emerald-400 border border-emerald-600/30 rounded hover:bg-emerald-600/30 transition-colors disabled:opacity-40"
                  >Start</button>
                  <button
                    @click="cancelAdopt"
                    class="text-[10px] px-1.5 py-0.5 text-gray-500 hover:text-gray-300 transition-colors"
                  >Cancel</button>
                </div>
              </template>
              <!-- Link issue inline form -->
              <template v-else-if="linkingWorktree?.worktreePath === wt.worktreePath">
                <div class="inline-flex items-center gap-1">
                  <input
                    v-model="linkIssueId"
                    type="text"
                    placeholder="Issue ID (e.g. NEXT-12345)"
                    class="bg-surface-dark border border-border rounded px-2 py-0.5 text-xs text-white w-40 focus:outline-none focus:border-blue-500"
                    @keyup.enter="submitLinkIssue"
                    @keyup.escape="cancelLinkIssue"
                  />
                  <button
                    @click="submitLinkIssue"
                    :disabled="!linkIssueId.trim()"
                    class="text-[10px] px-1.5 py-0.5 bg-blue-600/20 text-blue-400 border border-blue-600/30 rounded hover:bg-blue-600/30 transition-colors disabled:opacity-40"
                  >Save</button>
                  <button
                    @click="cancelLinkIssue"
                    class="text-[10px] px-1.5 py-0.5 text-gray-500 hover:text-gray-300 transition-colors"
                  >Cancel</button>
                </div>
              </template>
              <template v-else>
                <template v-if="wt.isPlugin">
                  <button
                    @click="startAdopt(wt)"
                    class="text-xs text-emerald-400 hover:text-emerald-300 mr-2 transition-colors"
                  >Start</button>
                  <button
                    @click="refreshExternal(wt)"
                    class="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
                  >Refresh</button>
                </template>
                <template v-else-if="wt.registered">
                  <button
                    @click="startLinkIssue(wt)"
                    class="text-xs text-blue-400 hover:text-blue-300 mr-2 transition-colors"
                  >Link Issue</button>
                  <button
                    @click="refreshExternal(wt)"
                    class="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
                  >Refresh</button>
                </template>
                <template v-else>
                  <button
                    @click="registerProject(wt)"
                    class="text-xs text-orange-400 hover:text-orange-300 mr-2 transition-colors"
                  >Register Project</button>
                  <button
                    @click="refreshExternal(wt)"
                    class="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
                  >Refresh</button>
                </template>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Empty state — only after initial load resolves so the skeleton
         block above stays in place during the first fetch. -->
    <div v-if="instancesLoaded && !hasInstances" class="text-center py-16 text-gray-500 min-h-[180px] flex flex-col items-center justify-center">
      <p class="text-lg mb-2">No worktrees</p>
      <p class="text-sm">Click <strong>+ Create</strong> to get started.</p>
    </div>

    <!-- Plugin widgets: dashboard-sidebar (above list) -->
    <div v-if="sidebarWidgets.length > 0" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
      <div
        v-for="w in sidebarWidgets"
        :key="`${w.pluginId}:${w.id}`"
        class="bg-surface border border-border rounded p-3"
      >
        <div v-if="w.title" class="text-xs text-gray-500 mb-2">{{ w.title }}</div>
        <PluginSlot :render="w.render" :key="`${w.pluginId}:${w.id}`" />
      </div>
    </div>

    <!-- Plugin widgets: dashboard-bottom -->
    <div v-if="bottomWidgets.length > 0" class="mt-6 space-y-3">
      <div
        v-for="w in bottomWidgets"
        :key="`${w.pluginId}:${w.id}`"
        class="bg-surface border border-border rounded p-3"
      >
        <div v-if="w.title" class="text-xs text-gray-500 mb-2">{{ w.title }}</div>
        <PluginSlot :render="w.render" :key="`${w.pluginId}:${w.id}`" />
      </div>
    </div>

    <!-- Modals -->
    <BatchCreateModal v-if="showBatchCreate" @close="router.push('/dashboard')" @refresh="refresh()" />
    <BatchDeleteModal v-if="showBatchDelete" :instances="batchDeleteInstances" @close="showBatchDelete = false" @refresh="refresh()" />
    <ProjectsModal v-if="showProjects" @close="router.push('/dashboard')" />
    <ConfirmDialog v-if="confirmAction" v-bind="confirmAction" @cancel="confirmAction = null" />

    <!-- Instance detail slide-over -->
    <InstanceDetail
      v-if="selectedInstance"
      :instance="selectedInstance"
      @close="router.push('/dashboard')"
      @refresh="refresh()"
    />
  </div>
</template>
