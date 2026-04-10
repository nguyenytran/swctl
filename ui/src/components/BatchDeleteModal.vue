<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useBatchDelete } from '@/composables/useBatchDelete'
import type { Instance } from '@/types'

const props = defineProps<{
  instances: Instance[]
}>()

const emit = defineEmits<{ close: []; refresh: [] }>()

const batch = useBatchDelete()

// Log auto-scroll
const logContainer = ref<HTMLElement | null>(null)
const userScrolledUp = ref(false)

function onLogScroll() {
  if (!logContainer.value) return
  const el = logContainer.value
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  userScrolledUp.value = !atBottom
}

function scrollToBottom() {
  if (logContainer.value) {
    logContainer.value.scrollTop = logContainer.value.scrollHeight
    userScrolledUp.value = false
  }
}

watch(() => batch.selectedLines.value.length, async () => {
  if (userScrolledUp.value) return
  await nextTick()
  scrollToBottom()
})

watch(() => batch.selectedJobId.value, () => {
  userScrolledUp.value = false
  nextTick(() => scrollToBottom())
})

// beforeunload protection
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (batch.isRunning.value) {
    e.preventDefault()
    e.returnValue = 'Batch deletion is still running. Are you sure you want to leave?'
    return e.returnValue
  }
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onUnmounted(() => window.removeEventListener('beforeunload', onBeforeUnload))

// Pre-populate jobs from selected instances
for (const inst of props.instances) {
  batch.addJob(inst.issueId, inst.issue || inst.issueId, inst.linkedPlugins.length > 0)
}

// Auto-select first job
if (batch.jobs.value.length > 0) {
  batch.selectedJobId.value = batch.jobs.value[0].id
}

// Auto-refresh when batch finishes
watch(() => batch.allDone.value, (done) => {
  if (done) emit('refresh')
})

function handleClose() {
  if (batch.isRunning.value) {
    if (!confirm('Cancel all running deletions and close?')) return
    batch.cancelAll()
  }
  emit('refresh')
  emit('close')
}

function startDelete() {
  batch.startAll()
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 bg-black/60 z-40" @click="handleClose"></div>
    <div class="fixed inset-4 bg-surface-dark z-50 flex flex-col rounded-lg border border-border overflow-hidden">
      <!-- Header -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-border bg-surface">
        <div class="flex items-center gap-4">
          <button class="text-gray-400 hover:text-white transition-colors text-lg" @click="handleClose">&larr;</button>
          <div>
            <h2 class="text-lg font-bold text-white">Batch Delete Worktrees</h2>
            <p class="text-xs text-gray-400 mt-0.5" v-if="batch.isStarted.value">
              <span class="text-emerald-400">{{ batch.successCount.value }} deleted</span> &middot;
              <span v-if="batch.runningCount.value" class="text-blue-400">{{ batch.runningCount.value }} deleting</span>
              <span v-if="batch.runningCount.value"> &middot; </span>
              {{ batch.pendingCount.value }} pending
              <span v-if="batch.failedCount.value" class="text-red-400">&middot; {{ batch.failedCount.value }} failed</span>
            </p>
            <p class="text-xs text-gray-400 mt-0.5" v-else>
              {{ batch.totalCount.value }} worktree{{ batch.totalCount.value !== 1 ? 's' : '' }} to delete
            </p>
          </div>
        </div>
        <div class="flex items-center gap-2">
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
        <!-- Left panel: job list -->
        <div class="w-2/5 border-r border-border flex flex-col overflow-hidden">
          <!-- Concurrency -->
          <div class="p-4 border-b border-border bg-surface" v-if="!batch.isStarted.value">
            <label class="block text-xs text-gray-400 mb-1">Concurrency ({{ batch.concurrency.value }})</label>
            <input
              type="range"
              v-model.number="batch.concurrency.value"
              min="1" max="4"
              class="w-full accent-red-500"
            />
          </div>

          <!-- Job list -->
          <div class="flex-1 overflow-y-auto">
            <div
              v-for="job in batch.jobs.value"
              :key="job.id"
              class="relative border-b border-border cursor-pointer transition-colors"
              :class="{
                'bg-red-600/10 border-l-2 border-l-red-500': batch.selectedJobId.value === job.id,
                'hover:bg-surface-hover': batch.selectedJobId.value !== job.id,
              }"
              @click="batch.selectedJobId.value = job.id"
            >
              <!-- Progress bar (top border) -->
              <div
                v-if="job.status === 'running' || job.status === 'success'"
                class="absolute top-0 left-0 h-0.5 transition-all duration-500 ease-out"
                :class="job.status === 'success' ? 'bg-emerald-400' : 'bg-red-400'"
                :style="{ width: `${job.progress}%` }"
              ></div>
              <div class="flex items-center gap-3 px-4 py-2.5">
                <!-- Status icon -->
                <span
                  class="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  :class="{
                    'bg-gray-600': job.status === 'pending',
                    'bg-red-400 animate-pulse': job.status === 'running',
                    'bg-emerald-400': job.status === 'success',
                    'bg-red-600': job.status === 'failed',
                  }"
                ></span>
                <!-- Issue info + progress -->
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-white font-mono truncate">{{ job.issue }}</div>
                  <div class="text-xs text-gray-500 truncate">
                    <template v-if="job.status === 'running' && job.progressLabel">
                      <span class="text-red-400">{{ job.progressLabel }}</span>
                      <span class="text-gray-600 mx-1">&middot;</span>
                      <span>{{ job.progress }}%</span>
                    </template>
                    <template v-else>
                      {{ job.issueId }}
                    </template>
                  </div>
                </div>
                <!-- Force badge -->
                <span
                  v-if="job.hasPlugins"
                  class="text-[10px] px-1.5 py-0.5 rounded border border-orange-500/40 text-orange-400 flex-shrink-0"
                >force</span>
                <!-- Remove button (only pending, before started) -->
                <button
                  v-if="job.status === 'pending' && !batch.isStarted.value"
                  class="text-gray-600 hover:text-red-400 transition-colors text-xs flex-shrink-0"
                  @click.stop="batch.removeJob(job.id)"
                  title="Remove"
                >
                  ✕
                </button>
                <!-- Status text -->
                <span v-else-if="job.status === 'success'" class="text-xs text-emerald-400 flex-shrink-0">deleted</span>
                <span v-else-if="job.status === 'failed'" class="text-xs text-red-400 flex-shrink-0">failed</span>
                <span v-else-if="job.status === 'running'" class="text-xs text-red-400 flex-shrink-0">{{ job.progress }}%</span>
              </div>
            </div>
          </div>

          <!-- Footer actions -->
          <div class="p-4 border-t border-border bg-surface flex items-center gap-2">
            <button
              v-if="!batch.isStarted.value"
              :disabled="batch.totalCount.value === 0"
              class="flex-1 px-4 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded transition-colors"
              @click="startDelete"
            >
              Delete {{ batch.totalCount.value }} Worktree{{ batch.totalCount.value !== 1 ? 's' : '' }}
            </button>
            <div v-else-if="batch.isRunning.value" class="flex-1 text-sm text-red-400 animate-pulse">
              Deleting {{ batch.runningCount.value }} worktree{{ batch.runningCount.value !== 1 ? 's' : '' }}...
            </div>
            <div v-else-if="batch.allDone.value" class="flex-1 text-sm text-emerald-400">
              All done — {{ batch.successCount.value }} deleted
              <span v-if="batch.failedCount.value" class="text-red-400">, {{ batch.failedCount.value }} failed</span>
            </div>
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
                  'bg-red-400 animate-pulse': batch.selectedStatus.value === 'running',
                  'bg-emerald-400': batch.selectedStatus.value === 'success',
                  'bg-red-600': batch.selectedStatus.value === 'failed',
                }"
              ></span>
              <span class="text-sm text-white font-mono">{{ batch.selectedJob.value.issue }}</span>
              <span class="text-xs text-gray-500">{{ batch.selectedJob.value.issueId }}</span>
              <span class="ml-auto text-xs" :class="{
                'text-gray-600': batch.selectedStatus.value === 'pending',
                'text-red-400': batch.selectedStatus.value === 'running',
                'text-emerald-400': batch.selectedStatus.value === 'success',
                'text-red-600': batch.selectedStatus.value === 'failed',
              }">
                {{ batch.selectedStatus.value === 'running' ? 'deleting' : batch.selectedStatus.value }}
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
                    {{ batch.selectedResult.value.exitCode === 0 ? 'Deleted successfully' : `Failed (exit ${batch.selectedResult.value.exitCode})` }}
                    in {{ Math.floor(batch.selectedResult.value.elapsed / 1000) }}s
                  </div>
                </template>
              </div>
              <!-- Scroll to bottom button -->
              <button
                v-if="userScrolledUp && batch.selectedRunning.value"
                class="absolute bottom-4 right-4 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs rounded-full shadow-lg transition-colors flex items-center gap-1"
                @click="scrollToBottom"
              >
                &darr; Latest
              </button>
            </div>
          </template>
          <div v-else class="flex-1 flex items-center justify-center text-gray-600 text-sm">
            <div class="text-center">
              <p class="text-lg mb-2">Click a job to view its logs</p>
              <p class="text-xs">Jobs will auto-select as they start</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
