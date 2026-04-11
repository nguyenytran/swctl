<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { useProjects } from '@/composables/useProjects'
import { useActiveProject } from '@/composables/useActiveProject'
import { useBatchCreate } from '@/composables/useBatchCreate'
import { fetchPlugins, fetchGitHubIssues, fetchGitHubStatus, githubLogout, requestDeviceCode, pollDeviceAuth } from '@/api'
import type { GitHubItem, GitHubAuthStatus } from '@/types'

const emit = defineEmits<{ close: []; refresh: [] }>()

const { projects } = useProjects()
const { activeProjectName } = useActiveProject()
const batch = useBatchCreate()

// Shared settings
const selectedProject = ref(activeProjectName.value || '')
const selectedPlugin = ref('')
const mode = ref<'dev' | 'qa'>('dev')
const availablePlugins = ref<string[]>([])

// Input mode: 'manual' | 'github'
const inputMode = ref<'manual' | 'github'>('manual')

// Manual input state
const quickAddText = ref('')
const manualIssue = ref('')
const manualBranch = ref('')

// GitHub import state
const ghRepo = ref('shopware/shopware')
const ghLoading = ref(false)
const ghError = ref('')
const ghAuthUrl = ref('')
const ghItems = ref<GitHubItem[]>([])
const ghSelected = ref<Set<number>>(new Set())
const ghRateLimit = ref<{ remaining: number; limit: number } | null>(null)
const ghAuth = ref<GitHubAuthStatus | null>(null)

// Device Flow state
const ghDeviceCode = ref<{ device_code: string; user_code: string; verification_uri: string; interval: number } | null>(null)
const ghPolling = ref(false)
const ghDeviceError = ref('')
let pollTimer: ReturnType<typeof setTimeout> | null = null

// Load GitHub auth status on mount
fetchGitHubStatus().then(s => { ghAuth.value = s }).catch(() => {})

// Clean up poll timer on unmount
onUnmounted(() => {
  if (pollTimer) clearTimeout(pollTimer)
})

async function startDeviceFlow() {
  ghDeviceError.value = ''
  ghDeviceCode.value = null
  const result = await requestDeviceCode()
  if ('error' in result) {
    ghDeviceError.value = result.error
    return
  }
  ghDeviceCode.value = {
    device_code: result.device_code,
    user_code: result.user_code,
    verification_uri: result.verification_uri,
    interval: result.interval || 5,
  }
  // Open GitHub in new tab
  window.open(result.verification_uri, '_blank')
  // Start polling
  ghPolling.value = true
  schedulePoll()
}

function schedulePoll() {
  if (!ghDeviceCode.value) return
  const interval = (ghDeviceCode.value.interval || 5) * 1000
  pollTimer = setTimeout(async () => {
    if (!ghDeviceCode.value) return
    const result = await pollDeviceAuth(ghDeviceCode.value.device_code)
    if (result.status === 'authorized') {
      ghPolling.value = false
      ghDeviceCode.value = null
      // Refresh auth status to get user info
      const status = await fetchGitHubStatus()
      ghAuth.value = status
    } else if (result.status === 'expired') {
      ghPolling.value = false
      ghDeviceError.value = 'Code expired. Click Login to try again.'
      ghDeviceCode.value = null
    } else if (result.status === 'error') {
      ghPolling.value = false
      ghDeviceError.value = result.error || 'Authentication failed'
      ghDeviceCode.value = null
    } else {
      // pending or slow_down — keep polling
      if (result.status === 'slow_down' && ghDeviceCode.value) {
        ghDeviceCode.value.interval = (ghDeviceCode.value.interval || 5) + 5
      }
      schedulePoll()
    }
  }, interval)
}

function cancelDeviceFlow() {
  if (pollTimer) clearTimeout(pollTimer)
  ghPolling.value = false
  ghDeviceCode.value = null
  ghDeviceError.value = ''
}

async function copyUserCode() {
  if (ghDeviceCode.value) {
    await navigator.clipboard.writeText(ghDeviceCode.value.user_code)
  }
}

async function handleGhLogout() {
  await githubLogout()
  ghAuth.value = { authenticated: false, deviceFlowConfigured: ghAuth.value?.deviceFlowConfigured ?? false }
  ghItems.value = []
}

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

// --- Manual add ---
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

// --- GitHub import ---
async function fetchFromGitHub() {
  if (!ghRepo.value.trim()) return
  ghLoading.value = true
  ghError.value = ''
  ghAuthUrl.value = ''
  ghItems.value = []
  ghSelected.value = new Set()

  try {
    const result = await fetchGitHubIssues(ghRepo.value.trim())
    if (result.rateLimit) ghRateLimit.value = result.rateLimit
    if (result.error) {
      ghError.value = result.error === 'rate_limited'
        ? `Rate limited. ${result.rateLimit?.remaining ?? 0}/${result.rateLimit?.limit ?? 0} requests remaining. Add a GitHub token for higher limits.`
        : result.error === 'auth_required'
          ? 'Authentication required for this repository.'
          : result.error
      ghAuthUrl.value = result.authUrl || ''
    } else {
      ghItems.value = result.items
    }
  } catch (err: any) {
    ghError.value = `Failed to fetch: ${err.message}`
  } finally {
    ghLoading.value = false
  }
}

function toggleGhItem(num: number) {
  const s = new Set(ghSelected.value)
  if (s.has(num)) s.delete(num)
  else s.add(num)
  ghSelected.value = s
}

function toggleAllGh() {
  if (ghSelected.value.size === ghItems.value.length) {
    ghSelected.value = new Set()
  } else {
    ghSelected.value = new Set(ghItems.value.map(i => i.number))
  }
}

/**
 * Derive branch prefix from GitHub issue type.
 * Bug -> fix/, Improvement -> feat/, Story -> feat/, default -> feature/
 */
function branchPrefixFromType(type?: string | null): string {
  switch (type?.toLowerCase()) {
    case 'bug': return 'fix'
    case 'improvement': return 'feat'
    case 'story': return 'feat'
    case 'task': return 'feature'
    case 'epic': return 'feature'
    default: return 'feature'
  }
}

function addSelectedGhItems() {
  for (const item of ghItems.value) {
    if (!ghSelected.value.has(item.number)) continue
    const issue = String(item.number)
    // Use linked PR branch if available, otherwise derive from issue type
    const branch = item.branch || `${branchPrefixFromType(item.issueType)}/${item.number}`
    batch.addJob(issue, branch, selectedPlugin.value)
  }
  ghSelected.value = new Set()
}

// --- Controls ---
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

      <!-- Body: top settings bar → middle content → bottom jobs+logs -->
      <div class="flex-1 flex flex-col overflow-hidden">
        <!-- Settings bar (compact single row) -->
        <div class="px-4 py-3 border-b border-border bg-surface">
          <div class="flex gap-3 items-end">
            <div class="w-40">
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
            <div class="w-40">
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
            <div class="w-24">
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
            <div class="w-32">
              <label class="block text-xs text-gray-400 mb-1">Concurrency ({{ batch.concurrency.value }})</label>
              <input
                type="range"
                v-model.number="batch.concurrency.value"
                min="1" max="4"
                :disabled="batch.isRunning.value"
                class="w-full accent-blue-500"
              />
            </div>
            <!-- Tab switcher -->
            <div v-if="!batch.isRunning.value" class="ml-auto">
              <div class="inline-flex bg-surface-dark rounded-full p-0.5 border border-border">
                <button
                  class="px-4 py-1.5 text-xs font-medium rounded-full transition-all"
                  :class="inputMode === 'manual'
                    ? 'bg-white text-black shadow-sm'
                    : 'text-gray-500 hover:text-gray-300'"
                  @click="inputMode = 'manual'"
                >Manual</button>
                <button
                  class="px-4 py-1.5 text-xs font-medium rounded-full transition-all"
                  :class="inputMode === 'github'
                    ? 'bg-white text-black shadow-sm'
                    : 'text-gray-500 hover:text-gray-300'"
                  @click="inputMode = 'github'"
                >GitHub</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Middle: full-width input area (issues/PRs or manual) -->
        <div v-if="!batch.isRunning.value" class="flex-1 overflow-y-auto border-b border-border">
            <!-- Manual input -->
            <div v-if="inputMode === 'manual'" class="p-4 space-y-3">
              <div>
                <label class="block text-xs text-gray-400 mb-1">Quick Add — paste issue IDs</label>
                <div class="flex gap-2">
                  <textarea
                    v-model="quickAddText"
                    rows="3"
                    class="flex-1 bg-surface-dark border border-border rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors font-mono resize-none"
                    placeholder="12345&#10;12346 fix/12346&#10;12347 feat/12347"
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

            <!-- GitHub import -->
            <div v-else class="p-4 space-y-3">
              <!-- Auth status bar -->
              <div class="flex items-center gap-2 text-xs flex-wrap">
                <template v-if="ghAuth?.authenticated">
                  <img :src="ghAuth.user?.avatar_url" class="w-4 h-4 rounded-full" />
                  <span class="text-gray-300">{{ ghAuth.user?.login }}</span>
                  <button class="text-gray-500 hover:text-gray-300 ml-auto transition-colors" @click="handleGhLogout">Logout</button>
                </template>
                <template v-else-if="ghAuth?.deviceFlowConfigured">
                  <!-- Not authenticated, device flow available -->
                  <template v-if="!ghDeviceCode">
                    <span class="text-gray-500">Not logged in</span>
                    <button
                      class="ml-auto px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors text-xs"
                      @click="startDeviceFlow"
                    >Login with GitHub</button>
                  </template>
                  <!-- Device flow in progress: show code -->
                  <template v-else>
                    <div class="flex items-center gap-2 w-full bg-surface-dark border border-border rounded p-2">
                      <span class="text-gray-400">Enter code:</span>
                      <code class="text-white font-bold text-sm tracking-widest select-all">{{ ghDeviceCode.user_code }}</code>
                      <button
                        class="text-gray-500 hover:text-white transition-colors"
                        @click="copyUserCode"
                        title="Copy code"
                      >
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke-width="2"/></svg>
                      </button>
                      <a
                        :href="ghDeviceCode.verification_uri"
                        target="_blank"
                        class="px-2 py-0.5 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors text-xs"
                      >Open GitHub</a>
                      <span v-if="ghPolling" class="text-blue-400 animate-pulse ml-auto">Waiting for authorization...</span>
                      <button
                        class="text-gray-600 hover:text-gray-300 transition-colors ml-1"
                        @click="cancelDeviceFlow"
                        title="Cancel"
                      >&#10005;</button>
                    </div>
                  </template>
                  <div v-if="ghDeviceError" class="w-full text-xs text-red-400 mt-1">{{ ghDeviceError }}</div>
                </template>
                <template v-else>
                  <span class="text-gray-600">No GitHub OAuth configured — using public API</span>
                </template>
              </div>

              <form @submit.prevent="fetchFromGitHub" class="flex gap-2">
                <input
                  v-model="ghRepo"
                  class="flex-1 bg-surface-dark border border-border rounded px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
                  placeholder="owner/repo"
                />
                <button
                  type="submit"
                  :disabled="ghLoading || !ghRepo.trim()"
                  class="px-4 bg-surface hover:bg-surface-hover text-gray-300 text-sm rounded border border-border transition-colors disabled:opacity-40"
                >
                  {{ ghLoading ? 'Loading...' : 'Fetch' }}
                </button>
              </form>

              <!-- Rate limit info -->
              <div v-if="ghRateLimit" class="text-[10px] text-gray-600">
                API: {{ ghRateLimit.remaining }}/{{ ghRateLimit.limit }} requests remaining
              </div>

              <!-- Error state -->
              <div v-if="ghError" class="text-xs text-red-400 bg-red-600/10 border border-red-600/20 rounded p-2">
                {{ ghError }}
                <button
                  v-if="ghAuth?.deviceFlowConfigured && !ghAuth?.authenticated"
                  class="ml-2 text-blue-400 hover:text-blue-300 underline"
                  @click="startDeviceFlow"
                >Login with GitHub</button>
              </div>

              <!-- Results -->
              <div v-if="ghItems.length > 0" class="space-y-2">
                <div class="flex items-center justify-between">
                  <button
                    class="text-xs text-gray-400 hover:text-white transition-colors"
                    @click="toggleAllGh"
                  >{{ ghSelected.size === ghItems.length ? 'Deselect all' : 'Select all' }} ({{ ghItems.length }})</button>
                  <button
                    :disabled="ghSelected.size === 0"
                    class="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs rounded transition-colors"
                    @click="addSelectedGhItems"
                  >
                    Add {{ ghSelected.size }} selected
                  </button>
                </div>
                <div class="overflow-y-auto border border-border rounded bg-surface-dark">
                  <div
                    v-for="item in ghItems"
                    :key="item.number"
                    class="flex items-start gap-2 px-3 py-2 border-b border-border last:border-b-0 hover:bg-surface-hover transition-colors"
                  >
                    <input
                      type="checkbox"
                      :checked="ghSelected.has(item.number)"
                      class="mt-0.5 accent-blue-500 cursor-pointer shrink-0"
                      @change="toggleGhItem(item.number)"
                    />
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2">
                        <a
                          :href="item.url"
                          target="_blank"
                          class="text-xs font-mono shrink-0 hover:underline"
                          :class="{
                            'text-blue-400': item.category === 'assigned',
                            'text-yellow-400': item.category === 'review-requested',
                            'text-purple-400': item.category === 'my-pr',
                          }"
                          @click.stop
                        >
                          {{ item.isPR ? 'PR' : '#' }}{{ item.number }}
                        </a>
                        <span
                          class="text-[10px] px-1 py-0 rounded shrink-0"
                          :class="{
                            'bg-blue-600/20 text-blue-400 border border-blue-600/30': item.category === 'assigned',
                            'bg-yellow-600/20 text-yellow-400 border border-yellow-600/30': item.category === 'review-requested',
                            'bg-purple-600/20 text-purple-400 border border-purple-600/30': item.category === 'my-pr',
                          }"
                        >{{ item.category === 'assigned' ? 'assigned' : item.category === 'review-requested' ? 'review' : 'my PR' }}</span>
                        <span
                          v-if="item.issueType"
                          class="text-[10px] px-1 py-0 rounded shrink-0"
                          :class="{
                            'bg-red-600/20 text-red-400 border border-red-600/30': item.issueType === 'Bug',
                            'bg-emerald-600/20 text-emerald-400 border border-emerald-600/30': item.issueType === 'Improvement',
                            'bg-yellow-600/20 text-yellow-400 border border-yellow-600/30': item.issueType === 'Story',
                            'bg-blue-600/20 text-blue-400 border border-blue-600/30': item.issueType === 'Task',
                            'bg-purple-600/20 text-purple-400 border border-purple-600/30': item.issueType === 'Epic',
                          }"
                        >{{ item.issueType }}</span>
                        <span class="text-xs text-white truncate">{{ item.title }}</span>
                      </div>
                      <div class="flex items-center gap-2 mt-0.5 flex-wrap">
                        <template v-if="item.linkedPRs?.length">
                          <a
                            :href="`https://github.com/${ghRepo}/pull/${item.linkedPRs[0].number}`"
                            target="_blank"
                            class="text-[10px] text-emerald-500 hover:underline font-mono shrink-0"
                            @click.stop
                          >&rarr; PR#{{ item.linkedPRs[0].number }}</a>
                          <span class="text-[10px] text-gray-500 font-mono truncate">{{ item.linkedPRs[0].branch }}</span>
                          <span
                            class="text-[10px] px-1 py-0 rounded shrink-0"
                            :class="{
                              'bg-emerald-600/20 text-emerald-400 border border-emerald-600/30': item.linkedPRs[0].state === 'open',
                              'bg-yellow-600/20 text-yellow-400 border border-yellow-600/30': item.linkedPRs[0].state === 'draft',
                              'bg-gray-600/20 text-gray-400 border border-gray-600/30': item.linkedPRs[0].state === 'closed' || item.linkedPRs[0].state === 'merged',
                            }"
                          >{{ item.linkedPRs[0].state }}</span>
                          <span v-if="item.linkedPRs.length > 1" class="text-[10px] text-gray-600">+{{ item.linkedPRs.length - 1 }} more</span>
                        </template>
                        <span v-else-if="item.branch" class="text-[10px] text-gray-500 font-mono truncate">{{ item.branch }}</span>
                        <span v-if="item.user" class="text-[10px] text-gray-600">@{{ item.user }}</span>
                        <span
                          v-for="label in item.labels.slice(0, 3)"
                          :key="label.name"
                          class="text-[10px] px-1 py-0 rounded"
                          :style="{ backgroundColor: `#${label.color}20`, color: `#${label.color}`, border: `1px solid #${label.color}40` }"
                        >{{ label.name }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Empty state -->
              <div v-else-if="!ghLoading && !ghError && ghRepo" class="text-xs text-gray-600 text-center py-2">
                {{ ghAuth?.authenticated ? 'Enter a repo and click Fetch to load your issues/PRs' : 'Login with GitHub to fetch your assigned issues and PRs' }}
              </div>
            </div>
          </div>

        <!-- Bottom panel: jobs (left) + log viewer (right) -->
        <div :class="batch.isRunning.value || batch.isStarted.value ? 'flex-1' : 'h-2/5'" class="flex overflow-hidden">
          <!-- Jobs queue -->
          <div class="w-2/5 flex flex-col overflow-hidden border-r border-border">
            <div class="px-4 py-2 border-b border-border bg-surface text-xs text-gray-400 font-medium flex items-center justify-between">
              <span>Jobs ({{ batch.jobs.value.length }})</span>
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
                      {{ job.branch || 'no branch' }}
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

          <!-- Log viewer -->
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
                {{ batch.selectedJob.value.branch || '' }}
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
    </div>
  </Teleport>
</template>
