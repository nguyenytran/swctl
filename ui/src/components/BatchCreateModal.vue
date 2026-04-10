<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useProjects } from '@/composables/useProjects'
import { useBatchCreate } from '@/composables/useBatchCreate'
import { fetchPlugins } from '@/api'

const emit = defineEmits<{ close: []; refresh: [] }>()

const { projects } = useProjects()
const batch = useBatchCreate()

// Shared settings
const selectedProject = ref('')
const selectedPlugin = ref('')
const mode = ref<'dev' | 'qa'>('dev')
const availablePlugins = ref<string[]>([])

// Input state
const quickAddText = ref('')
const manualIssue = ref('')
const manualBranch = ref('')

// Log auto-scroll
const logContainer = ref<HTMLElement | null>(null)
const userScrolledUp = ref(false)

function onLogScroll() {
  if (!logContainer.value) return
  const el = logContainer.value
  // User is "at bottom" if within 40px of the end
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  userScrolledUp.value = !atBottom
}

function scrollToBottom() {
  if (logContainer.value) {
    logContainer.value.scrollTop = logContainer.value.scrollHeight
    userScrolledUp.value = false
  }
}

// Auto-scroll when new lines arrive (only if user hasn't scrolled up)
watch(() => batch.selectedLines.value.length, async () => {
  if (userScrolledUp.value) return
  await nextTick()
  scrollToBottom()
})

// Reset scroll state when switching jobs
watch(() => batch.selectedJobId.value, () => {
  userScrolledUp.value = false
  nextTick(() => scrollToBottom())
})

const platformProjects = computed(() => projects.value.filter(p => p.type === 'platform'))
const canStart = computed(() =>
  batch.pendingCount.value > 0 && selectedProject.value !== '' && !batch.isRunning.value
)

// Load plugins when project changes
watch(selectedProject, async (proj) => {
  selectedPlugin.value = ''
  availablePlugins.value = []
  if (!proj) return
  try {
    availablePlugins.value = await fetchPlugins(proj)
  } catch {
    availablePlugins.value = []
  }
})

// Auto-refresh instances when a batch finishes
watch(() => batch.allDone.value, (done) => {
  if (done) emit('refresh')
})

function addFromTextarea() {
  const entries = batch.parseMultilineInput(quickAddText.value)
  for (const e of entries) {
    batch.addJob(e.issue, e.branch, selectedPlugin.value)
  }
  quickAddText.value = ''
}

function addManual() {
  if (!manualIssue.value.trim()) return
  batch.addJob(manualIssue.value, manualBranch.value, selectedPlugin.value)
  manualIssue.value = ''
  manualBranch.value = ''
}

function startBatch() {
  if (!canStart.value) return
  batch.startAll(selectedProject.value, mode.value)
}

function handleClose() {
  if (batch.isRunning.value) {
    if (!confirm('Cancel all running jobs and close?')) return
    batch.cancelAll()
  }
  emit('refresh')
  emit('close')
}

function handleNewBatch() {
  batch.clearCompleted()
  batch.resetForNewBatch()
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 bg-black/60 z-40" @click="handleClose"></div>
    <div class="fixed inset-0 bg-surface-dark z-50 flex flex-col">
      <!-- Header -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-border bg-surface">
        <div class="flex items-center gap-4">
          <button class="text-gray-400 hover:text-white transition-colors text-lg" @click="handleClose">&larr;</button>
          <div>
            <h2 class="text-lg font-bold text-white">Batch Create Worktrees</h2>
            <p class="text-xs text-gray-400 mt-0.5" v-if="batch.isStarted.value">
              <span class="text-emerald-400">{{ batch.successCount.value }} done</span> &middot;
              <span v-if="batch.runningCount.value" class="text-blue-400">{{ batch.runningCount.value }} running</span>
              <span v-if="batch.runningCount.value"> &middot; </span>
              {{ batch.pendingCount.value }} pending
              <span v-if="batch.failedCount.value" class="text-red-400">&middot; {{ batch.failedCount.value }} failed</span>
            </p>
            <p class="text-xs text-gray-400 mt-0.5" v-else>
              {{ batch.totalCount.value }} job{{ batch.totalCount.value !== 1 ? 's' : '' }} queued
            </p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button
            v-if="batch.allDone.value"
            class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition-colors"
            @click="handleNewBatch"
          >
            + New Batch
          </button>
          <button
            v-if="batch.isRunning.value"
            class="px-3 py-1 text-xs bg-red-600/20 text-red-400 border border-red-600/30 rounded hover:bg-red-600/30 transition-colors"
            @click="batch.cancelAll()"
          >
            Cancel All
          </button>
          <button
            class="px-3 py-1 text-xs bg-surface-dark text-gray-400 border border-border rounded hover:text-white transition-colors"
            @click="handleClose"
          >
            Close
          </button>
        </div>
      </div>

      <!-- Two-panel body -->
      <div class="flex-1 flex overflow-hidden">
        <!-- Left panel: settings + job list -->
        <div class="w-2/5 border-r border-border flex flex-col overflow-hidden">
          <!-- Shared settings -->
          <div class="p-4 border-b border-border space-y-3 bg-surface">
            <div class="flex gap-3">
              <div class="flex-1">
                <label class="block text-xs text-gray-400 mb-1">Project *</label>
                <select
                  v-model="selectedProject"
                  :disabled="batch.isRunning.value"
                  class="w-full bg-surface-dark border border-border rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-40"
                >
                  <option value="" disabled>Select a project</option>
                  <option v-for="p in platformProjects" :key="p.name" :value="p.name">{{ p.name }}</option>
                </select>
              </div>
              <div class="flex-1">
                <label class="block text-xs text-gray-400 mb-1">Plugin</label>
                <select
                  v-model="selectedPlugin"
                  :disabled="!availablePlugins.length || batch.isRunning.value"
                  class="w-full bg-surface-dark border border-border rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-40"
                >
                  <option value="">{{ availablePlugins.length ? 'Platform only' : 'No plugins' }}</option>
                  <option v-for="p in availablePlugins" :key="p" :value="p">{{ p }}</option>
                </select>
              </div>
            </div>
            <div class="flex gap-3 items-end">
              <div class="flex-1">
                <label class="block text-xs text-gray-400 mb-1">Mode</label>
                <select
                  v-model="mode"
                  :disabled="batch.isRunning.value"
                  class="w-full bg-surface-dark border border-border rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-40"
                >
                  <option value="dev">Dev</option>
                  <option value="qa">QA</option>
                </select>
              </div>
              <div class="flex-1">
                <label class="block text-xs text-gray-400 mb-1">Concurrency ({{ batch.concurrency.value }})</label>
                <input
                  type="range"
                  v-model.number="batch.concurrency.value"
                  min="1" max="4"
                  :disabled="batch.isRunning.value"
                  class="w-full accent-blue-500"
                />
              </div>
            </div>
          </div>

          <!-- Quick-add + manual add (shown when not running) -->
          <div v-if="!batch.isRunning.value" class="p-4 border-b border-border space-y-3">
            <div>
              <label class="block text-xs text-gray-400 mb-1">Quick Add — paste issue IDs</label>
              <div class="flex gap-2">
                <textarea
                  v-model="quickAddText"
                  rows="3"
                  class="flex-1 bg-surface-dark border border-border rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors font-mono resize-none"
                  placeholder="NEXT-12345&#10;NEXT-12346 feature/my-branch&#10;NEXT-12347"
                ></textarea>
                <button
                  :disabled="!quickAddText.trim()"
                  class="px-3 self-end bg-surface hover:bg-surface-hover text-gray-300 text-sm rounded border border-border transition-colors disabled:opacity-40"
                  @click="addFromTextarea"
                >
                  Add
                </button>
              </div>
            </div>
            <form @submit.prevent="addManual" class="flex gap-2">
              <input
                v-model="manualIssue"
                class="flex-1 bg-surface-dark border border-border rounded px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
                placeholder="Issue ID"
              />
              <input
                v-model="manualBranch"
                class="flex-1 bg-surface-dark border border-border rounded px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
                placeholder="Branch (optional)"
              />
              <button
                type="submit"
                :disabled="!manualIssue.trim()"
                class="px-3 bg-surface hover:bg-surface-hover text-gray-300 text-sm rounded border border-border transition-colors disabled:opacity-40"
              >
                +
              </button>
            </form>
          </div>

          <!-- Job list -->
          <div class="flex-1 overflow-y-auto">
            <div v-if="batch.jobs.value.length === 0" class="p-8 text-center text-gray-600 text-sm">
              Add issues above to get started
            </div>
            <div
              v-for="job in batch.jobs.value"
              :key="job.id"
              class="relative border-b border-border cursor-pointer transition-colors"
              :class="{
                'bg-blue-600/10 border-l-2 border-l-blue-500': batch.selectedJobId.value === job.id,
                'hover:bg-surface-hover': batch.selectedJobId.value !== job.id,
              }"
              @click="batch.selectedJobId.value = job.id"
            >
              <!-- Progress bar (top border) -->
              <div
                v-if="job.status === 'running' || job.status === 'success'"
                class="absolute top-0 left-0 h-0.5 transition-all duration-500 ease-out"
                :class="job.status === 'success' ? 'bg-emerald-400' : 'bg-blue-400'"
                :style="{ width: `${job.progress}%` }"
              ></div>
              <div class="flex items-center gap-3 px-4 py-2.5">
                <!-- Status icon -->
                <span
                  class="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  :class="{
                    'bg-gray-600': job.status === 'pending',
                    'bg-blue-400 animate-pulse': job.status === 'running',
                    'bg-emerald-400': job.status === 'success',
                    'bg-red-400': job.status === 'failed',
                  }"
                ></span>
                <!-- Issue + branch + progress -->
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-white font-mono truncate">{{ job.issue }}</div>
                  <div class="text-xs text-gray-500 truncate">
                    <template v-if="job.status === 'running' && job.progressLabel">
                      <span class="text-blue-400">{{ job.progressLabel }}</span>
                      <span class="text-gray-600 mx-1">&middot;</span>
                      <span>{{ job.progress }}%</span>
                    </template>
                    <template v-else>
                      {{ job.branch || (mode === 'dev' ? `feature/${job.issue}` : 'no branch') }}
                    </template>
                  </div>
                </div>
                <!-- Remove button (only pending) -->
                <button
                  v-if="job.status === 'pending'"
                  class="text-gray-600 hover:text-red-400 transition-colors text-xs flex-shrink-0"
                  @click.stop="batch.removeJob(job.id)"
                  title="Remove"
                >
                  ✕
                </button>
                <!-- Status text for completed -->
                <span v-else-if="job.status === 'success'" class="text-xs text-emerald-400 flex-shrink-0">done</span>
                <span v-else-if="job.status === 'failed'" class="text-xs text-red-400 flex-shrink-0">failed</span>
                <span v-else-if="job.status === 'running'" class="text-xs text-blue-400 flex-shrink-0">{{ job.progress }}%</span>
              </div>
            </div>
          </div>

          <!-- Footer actions -->
          <div class="p-4 border-t border-border bg-surface flex items-center gap-2">
            <button
              v-if="!batch.isRunning.value"
              :disabled="!canStart"
              class="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded transition-colors"
              @click="startBatch"
            >
              Start{{ batch.isStarted.value ? ' Remaining' : '' }} ({{ batch.pendingCount.value }})
            </button>
            <div v-else class="flex-1 text-sm text-blue-400 animate-pulse">
              Running {{ batch.runningCount.value }} job{{ batch.runningCount.value !== 1 ? 's' : '' }}...
            </div>
            <button
              v-if="batch.successCount.value > 0 || batch.failedCount.value > 0"
              class="px-3 py-2 text-xs text-gray-400 hover:text-white border border-border rounded transition-colors"
              @click="batch.clearCompleted()"
            >
              Clear Done
            </button>
          </div>
        </div>

        <!-- Right panel: log viewer -->
        <div class="flex-1 flex flex-col overflow-hidden">
          <template v-if="batch.selectedJob.value">
            <div class="px-4 py-2 bg-surface border-b border-border flex items-center gap-2">
              <span
                class="w-2 h-2 rounded-full"
                :class="{
                  'bg-gray-600': batch.selectedStatus.value === 'pending',
                  'bg-blue-400 animate-pulse': batch.selectedStatus.value === 'running',
                  'bg-emerald-400': batch.selectedStatus.value === 'success',
                  'bg-red-400': batch.selectedStatus.value === 'failed',
                }"
              ></span>
              <span class="text-sm text-white font-mono">{{ batch.selectedJob.value.issue }}</span>
              <span class="text-xs text-gray-500">
                {{ batch.selectedJob.value.branch || (mode === 'dev' ? `feature/${batch.selectedJob.value.issue}` : '') }}
              </span>
              <span class="ml-auto text-xs" :class="{
                'text-gray-600': batch.selectedStatus.value === 'pending',
                'text-blue-400': batch.selectedStatus.value === 'running',
                'text-emerald-400': batch.selectedStatus.value === 'success',
                'text-red-400': batch.selectedStatus.value === 'failed',
              }">
                {{ batch.selectedStatus.value }}
              </span>
            </div>
            <div class="flex-1 relative overflow-hidden">
              <div
                ref="logContainer"
                class="absolute inset-0 overflow-y-auto p-4 font-mono text-xs leading-5 bg-black"
                @scroll="onLogScroll"
              >
                <div v-if="batch.selectedStatus.value === 'pending'" class="text-gray-600">
                  Waiting to start...
                </div>
                <template v-else>
                  <div v-for="(line, i) in batch.selectedLines.value" :key="i" class="text-gray-300 whitespace-pre-wrap break-all">{{ line.line }}</div>
                  <div v-if="batch.selectedRunning.value && !batch.selectedLines.value.length" class="text-gray-600">
                    Waiting for output...
                  </div>
                  <div v-if="batch.selectedResult.value" class="mt-2 text-xs" :class="batch.selectedResult.value.exitCode === 0 ? 'text-emerald-500' : 'text-red-400'">
                    {{ batch.selectedResult.value.exitCode === 0 ? 'Completed successfully' : `Failed (exit ${batch.selectedResult.value.exitCode})` }}
                    in {{ Math.floor(batch.selectedResult.value.elapsed / 1000) }}s
                  </div>
                </template>
              </div>
              <!-- Scroll to bottom button -->
              <button
                v-if="userScrolledUp && batch.selectedRunning.value"
                class="absolute bottom-4 right-4 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-full shadow-lg transition-colors flex items-center gap-1"
                @click="scrollToBottom"
              >
                &darr; Latest
              </button>
            </div>
          </template>
          <div v-else class="flex-1 flex items-center justify-center text-gray-600 text-sm">
            <div class="text-center">
              <p class="text-lg mb-2">Click a job to view its logs</p>
              <p class="text-xs">Jobs will auto-select as they start running</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
