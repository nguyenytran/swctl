<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useInstances } from '@/composables/useInstances'
import { useStream } from '@/composables/useStream'
import { useResolve } from '@/composables/useResolve'
import { fetchDiff, fetchGitHubIssues, fetchDefaultIssueLabels } from '@/api'
import { buildResolveStreamUrl, buildAskStreamUrl, finishResolve } from '@/api/resolve'
import type { PrInfo } from '@/api/resolve'
import type { GitHubItem } from '@/types'
import LogPanel from './LogPanel.vue'

const { instances, refresh: refreshInstances } = useInstances()
const { runs, refresh: refreshRuns, getPr, getPrCreatePreview, prAction } = useResolve()
const resolveStream = useStream()
const askStream = useStream()

// State
const selectedIssueId = ref<string>('')
const activeTab = ref<'diff' | 'claude' | 'pr'>('diff')
const askMessage = ref('')
const prInfo = ref<PrInfo | null>(null)
const prLoading = ref(false)
const prActionLoading = ref('')
const diffStat = ref('')
const diffContent = ref('')
const diffLoading = ref(false)
const newIssueUrl = ref('')

// GitHub browse picker — same label-chip filter flow as BatchCreateModal but
// inline in the Resolve sidebar so users don't have to juggle URLs.
const ghShow = ref(false)
const ghLoading = ref(false)
const ghError = ref('')
const ghItems = ref<GitHubItem[]>([])
const ghDefaultLabels = ref<string[]>([])
const ghSelectedLabels = ref<string[]>([])
let ghDefaultsLoaded = false

async function toggleGhPicker() {
  ghShow.value = !ghShow.value
  if (ghShow.value && ghItems.value.length === 0 && !ghLoading.value) {
    await refreshGh()
  }
}

async function refreshGh() {
  ghLoading.value = true
  ghError.value = ''
  try {
    if (!ghDefaultsLoaded) {
      const defaults = await fetchDefaultIssueLabels()
      ghDefaultLabels.value = defaults
      ghSelectedLabels.value = [...defaults]
      ghDefaultsLoaded = true
    }
    const result = await fetchGitHubIssues(undefined, ghSelectedLabels.value)
    if (result.error) {
      ghError.value = result.error === 'auth_required'
        ? 'GitHub authentication required (Dashboard → GitHub).'
        : result.error
      ghItems.value = []
    } else {
      ghItems.value = (result.items || []).filter((it) => it.category === 'assigned')
    }
  } catch (err: any) {
    ghError.value = err?.message || 'Failed to fetch'
  } finally {
    ghLoading.value = false
  }
}

function removeGhLabel(label: string) {
  ghSelectedLabels.value = ghSelectedLabels.value.filter((l) => l !== label)
  refreshGh()
}

function resetGhLabels() {
  ghSelectedLabels.value = [...ghDefaultLabels.value]
  refreshGh()
}

function resolveGhItem(item: GitHubItem) {
  // Hand off to the existing startResolve pipeline — builds the worktree,
  // launches Claude, mirrors what typing a URL into the input does.
  const url = item.url || `https://github.com/${item.repo || 'shopware/shopware'}/issues/${item.number}`
  newIssueUrl.value = url
  ghShow.value = false
  startResolve()
}

// Filter to instances that have resolve sessions (Claude metadata)
const resolveInstances = computed(() => {
  return instances.value.filter((i: any) =>
    i.kind === 'managed' && (i.claudeSessionId || i.branch?.startsWith('fix/') || i.branch?.startsWith('resolve/'))
  )
})

const selectedInstance = computed(() => {
  if (!selectedIssueId.value) return null
  return instances.value.find((i: any) => i.issueId === selectedIssueId.value) || null
})

// Load diff when issue changes or tab switches to diff
watch([selectedIssueId, activeTab], async () => {
  if (activeTab.value !== 'diff' || !selectedIssueId.value) return
  diffLoading.value = true
  try {
    const result = await fetchDiff(selectedIssueId.value)
    diffStat.value = result.stat || ''
    diffContent.value = result.diff || ''
  } catch {
    diffStat.value = ''
    diffContent.value = 'Failed to load diff'
  } finally {
    diffLoading.value = false
  }
})

// Load PR info when tab switches to pr
watch([selectedIssueId, activeTab], async () => {
  if (activeTab.value !== 'pr' || !selectedIssueId.value) return
  prLoading.value = true
  try {
    prInfo.value = await getPr(selectedIssueId.value)
  } catch {
    prInfo.value = null
  } finally {
    prLoading.value = false
  }
})

function selectIssue(issueId: string) {
  selectedIssueId.value = issueId
  activeTab.value = 'diff'
}

function startResolve() {
  if (!newIssueUrl.value) return
  const url = buildResolveStreamUrl(newIssueUrl.value)
  resolveStream.start(url)
  newIssueUrl.value = ''
}

function sendAsk() {
  if (!askMessage.value || !selectedIssueId.value) return
  const url = buildAskStreamUrl(selectedIssueId.value, askMessage.value)
  askStream.start(url)
  askMessage.value = ''
}

async function handlePrAction(action: 'push' | 'merge' | 'approve' | 'ready') {
  if (!selectedIssueId.value) return
  prActionLoading.value = action
  try {
    await prAction(selectedIssueId.value, action)
    prInfo.value = await getPr(selectedIssueId.value)
  } catch (e) {
    console.error('PR action failed:', e)
  } finally {
    prActionLoading.value = ''
  }
}

// --- Create-PR modal ---
const showCreateModal = ref(false)
const createPreviewLoading = ref(false)
const createPreviewError = ref('')
const createSubmitting = ref(false)
const createResult = ref<{ ok: boolean; output: string } | null>(null)
const createForm = ref({
  title: '',
  body: '',
  baseBranch: '',
  branch: '',
  repo: '',
  linkRef: '',
  bodySource: '' as string,
  commitCount: 0,
})

async function openCreateModal() {
  if (!selectedIssueId.value) return
  showCreateModal.value = true
  createPreviewLoading.value = true
  createPreviewError.value = ''
  createResult.value = null
  try {
    const p = await getPrCreatePreview(selectedIssueId.value)
    if (!p.ok) {
      createPreviewError.value = p.error || 'Failed to build preview'
      return
    }
    createForm.value = {
      title: p.title || '',
      body: p.body || '',
      baseBranch: p.baseBranch || '',
      branch: p.branch || '',
      repo: p.repo || '',
      linkRef: p.linkRef || '',
      bodySource: p.bodySource || '',
      commitCount: p.commitCount || 0,
    }
  } catch (e: any) {
    createPreviewError.value = e?.message || 'Preview failed'
  } finally {
    createPreviewLoading.value = false
  }
}

function closeCreateModal() {
  if (createSubmitting.value) return
  showCreateModal.value = false
  createResult.value = null
}

async function confirmCreate() {
  if (!selectedIssueId.value) return
  createSubmitting.value = true
  createResult.value = null
  prActionLoading.value = 'create'
  try {
    const result = await prAction(selectedIssueId.value, 'create', {
      title: createForm.value.title,
      body: createForm.value.body,
      baseBranch: createForm.value.baseBranch,
    })
    createResult.value = result
    if (result.ok) {
      prInfo.value = await getPr(selectedIssueId.value)
      // Auto-close on success after a brief pause so the user sees the output
      setTimeout(() => { showCreateModal.value = false }, 1200)
    }
  } catch (e: any) {
    createResult.value = { ok: false, output: e?.message || 'Request failed' }
  } finally {
    createSubmitting.value = false
    prActionLoading.value = ''
  }
}

onMounted(async () => {
  await refreshInstances()
  await refreshRuns()
  if (resolveInstances.value.length > 0) {
    selectIssue((resolveInstances.value[0] as any).issueId)
  }
})
</script>

<template>
  <div class="flex gap-4 h-[calc(100vh-120px)]">
    <!-- Left sidebar: issue list -->
    <div class="w-64 flex-shrink-0 border border-border rounded-lg bg-surface overflow-hidden flex flex-col">
      <div class="px-3 py-2 border-b border-border flex items-center justify-between">
        <span class="text-sm font-semibold text-white">Issues</span>
        <span class="text-xs text-gray-500">{{ resolveInstances.length }}</span>
      </div>

      <div class="overflow-y-auto flex-1">
        <button
          v-for="inst in resolveInstances"
          :key="(inst as any).issueId"
          class="w-full text-left px-3 py-2 text-sm border-b border-border/50 transition-colors"
          :class="selectedIssueId === (inst as any).issueId
            ? 'bg-blue-500/10 text-white border-l-2 border-l-blue-400'
            : 'text-gray-400 hover:bg-surface-dark hover:text-gray-200'"
          @click="selectIssue((inst as any).issueId)"
        >
          <div class="flex items-center gap-2">
            <span
              class="w-2 h-2 rounded-full flex-shrink-0"
              :class="{
                'bg-emerald-400': (inst as any).claudeResolveStatus === 'done' || (inst as any).status === 'complete',
                'bg-yellow-400 animate-pulse': (inst as any).claudeResolveStatus === 'running',
                'bg-red-400': (inst as any).claudeResolveStatus === 'failed',
                'bg-gray-500': !(inst as any).claudeResolveStatus,
              }"
            />
            <span class="font-medium">#{{ (inst as any).issueId }}</span>
          </div>
          <div class="text-xs text-gray-500 mt-0.5 truncate">{{ (inst as any).branch }}</div>
        </button>
      </div>

      <!-- Browse GitHub issues (filtered by labels) -->
      <div class="border-t border-border">
        <button
          class="w-full px-3 py-1.5 text-xs text-left text-gray-400 hover:text-white transition-colors flex items-center justify-between"
          @click="toggleGhPicker"
        >
          <span>{{ ghShow ? '▾' : '▸' }} Browse GitHub</span>
          <span v-if="ghShow && ghItems.length > 0" class="text-[10px] text-gray-600">{{ ghItems.length }}</span>
        </button>
        <div v-if="ghShow" class="px-2 pb-2">
          <div
            v-if="ghDefaultLabels.length > 0"
            class="flex items-center flex-wrap gap-1 mb-2"
          >
            <span
              v-for="label in ghSelectedLabels"
              :key="label"
              class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-600/20 text-blue-300 border border-blue-600/40"
            >
              {{ label }}
              <button
                class="text-blue-300/70 hover:text-white text-[11px] leading-none"
                :title="`Remove ${label} — re-fetch`"
                @click="removeGhLabel(label)"
              >×</button>
            </span>
            <button
              v-if="ghSelectedLabels.length < ghDefaultLabels.length"
              class="text-[10px] px-1.5 py-0.5 rounded-full border border-border text-gray-500 hover:text-gray-300 hover:border-gray-500 transition-colors"
              :title="`Restore ${ghDefaultLabels.length} default labels`"
              @click="resetGhLabels"
            >Reset</button>
            <span v-if="ghSelectedLabels.length === 0" class="text-[10px] text-gray-600 italic">no labels selected</span>
          </div>

          <div v-if="ghLoading" class="text-xs text-gray-500 italic px-1 py-2">Loading…</div>
          <div v-else-if="ghError" class="text-xs text-red-400 px-1 py-2">{{ ghError }}</div>
          <div v-else-if="ghItems.length === 0" class="text-xs text-gray-600 italic px-1 py-2">No issues match.</div>
          <div v-else class="max-h-48 overflow-y-auto border border-border rounded bg-surface-dark">
            <button
              v-for="item in ghItems"
              :key="`${item.repo}#${item.number}`"
              class="w-full text-left px-2 py-1.5 text-xs border-b border-border/50 last:border-b-0 hover:bg-surface transition-colors"
              :title="item.title"
              @click="resolveGhItem(item)"
            >
              <div class="text-blue-400 font-mono text-[11px]">#{{ item.number }}</div>
              <div class="text-gray-300 truncate">{{ item.title }}</div>
            </button>
          </div>
        </div>
      </div>

      <!-- New resolve input -->
      <div class="p-2 border-t border-border">
        <div class="flex gap-1">
          <input
            v-model="newIssueUrl"
            placeholder="Issue URL or #number"
            class="flex-1 bg-surface-dark border border-border rounded px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
            @keydown.enter="startResolve"
          />
          <button
            class="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-500 transition-colors"
            :disabled="!newIssueUrl || resolveStream.running.value"
            @click="startResolve"
          >+</button>
        </div>
      </div>
    </div>

    <!-- Main content area -->
    <div class="flex-1 border border-border rounded-lg bg-surface overflow-hidden flex flex-col" v-if="selectedInstance">
      <!-- Tabs -->
      <div class="flex border-b border-border">
        <button
          v-for="tab in (['diff', 'claude', 'pr'] as const)"
          :key="tab"
          class="px-4 py-2 text-sm transition-colors"
          :class="activeTab === tab
            ? 'text-white border-b-2 border-blue-400 bg-surface-dark'
            : 'text-gray-500 hover:text-gray-300'"
          @click="activeTab = tab"
        >
          {{ tab === 'diff' ? 'Diff' : tab === 'claude' ? 'Claude' : 'PR' }}
        </button>
        <div class="flex-1" />
        <div class="px-3 py-2 text-xs text-gray-500">
          {{ (selectedInstance as any).branch }}
        </div>
      </div>

      <!-- Diff tab -->
      <div v-if="activeTab === 'diff'" class="flex-1 overflow-auto p-4">
        <div v-if="diffLoading" class="text-gray-500 text-sm">Loading diff...</div>
        <div v-else-if="!diffContent" class="text-gray-500 text-sm">No changes</div>
        <div v-else>
          <pre class="text-xs text-gray-400 mb-4 whitespace-pre-wrap">{{ diffStat }}</pre>
          <pre class="text-xs leading-5 whitespace-pre overflow-x-auto"><template v-for="(line, idx) in diffContent.split('\n')" :key="idx"><span
            :class="{
              'text-emerald-400': line.startsWith('+') && !line.startsWith('+++'),
              'text-red-400': line.startsWith('-') && !line.startsWith('---'),
              'text-blue-400': line.startsWith('@@'),
              'text-yellow-300 font-bold': line.startsWith('diff '),
              'text-gray-500': line.startsWith('---') || line.startsWith('+++'),
              'text-gray-400': !line.startsWith('+') && !line.startsWith('-') && !line.startsWith('@@') && !line.startsWith('diff '),
            }"
          >{{ line }}
</span></template></pre>
        </div>
      </div>

      <!-- Claude tab -->
      <div v-if="activeTab === 'claude'" class="flex-1 flex flex-col overflow-hidden">
        <div class="flex-1 overflow-auto p-4">
          <div v-if="askStream.lines.value.length === 0 && !askStream.running.value" class="text-gray-500 text-sm">
            Ask Claude about this issue's code changes. The response will appear here.
          </div>
          <div v-else class="space-y-1">
            <div
              v-for="(ev, idx) in askStream.lines.value"
              :key="idx"
              class="text-xs text-gray-300 font-mono whitespace-pre-wrap"
            >{{ (ev as any).line }}</div>
          </div>
          <div v-if="askStream.running.value" class="mt-2">
            <span class="text-xs text-yellow-400 animate-pulse">Claude is thinking...</span>
          </div>
        </div>
        <div class="p-3 border-t border-border flex gap-2">
          <input
            v-model="askMessage"
            placeholder="Ask Claude about this code..."
            class="flex-1 bg-surface-dark border border-border rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
            @keydown.enter="sendAsk"
            :disabled="askStream.running.value"
          />
          <button
            class="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-500 transition-colors disabled:opacity-50"
            :disabled="!askMessage || askStream.running.value"
            @click="sendAsk"
          >Send</button>
        </div>
      </div>

      <!-- PR tab -->
      <div v-if="activeTab === 'pr'" class="flex-1 overflow-auto p-4">
        <div v-if="prLoading" class="text-gray-500 text-sm">Loading PR info...</div>
        <div v-else-if="!prInfo || prInfo.notFound" class="space-y-4">
          <div class="text-gray-500 text-sm">No PR found for this branch.</div>
          <div class="flex gap-2">
            <button
              class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-500 transition-colors disabled:opacity-50"
              :disabled="prActionLoading === 'push'"
              @click="handlePrAction('push')"
            >Push Branch</button>
            <button
              class="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-500 transition-colors disabled:opacity-50"
              :disabled="prActionLoading === 'create'"
              @click="openCreateModal"
            >Create Draft PR…</button>
          </div>
        </div>
        <div v-else class="space-y-4">
          <div class="border border-border rounded-lg p-4">
            <div class="flex items-center gap-3">
              <span
                class="px-2 py-0.5 text-xs rounded-full font-medium"
                :class="{
                  'bg-emerald-500/20 text-emerald-400': prInfo.state === 'OPEN' && !prInfo.draft,
                  'bg-gray-500/20 text-gray-400': prInfo.draft,
                  'bg-purple-500/20 text-purple-400': prInfo.state === 'MERGED',
                  'bg-red-500/20 text-red-400': prInfo.state === 'CLOSED',
                }"
              >{{ prInfo.draft ? 'DRAFT' : prInfo.state }}</span>
              <span class="text-white font-medium">#{{ prInfo.number }}</span>
            </div>
            <div class="text-sm text-gray-300 mt-2">{{ prInfo.title }}</div>
            <a
              :href="prInfo.url"
              target="_blank"
              class="text-xs text-blue-400 hover:text-blue-300 mt-1 inline-block"
            >{{ prInfo.url }}</a>
          </div>

          <div class="flex gap-2 flex-wrap">
            <button
              class="px-3 py-1.5 text-sm bg-surface-dark border border-border text-gray-300 rounded hover:bg-surface hover:text-white transition-colors disabled:opacity-50"
              :disabled="!!prActionLoading"
              @click="handlePrAction('push')"
            >
              {{ prActionLoading === 'push' ? 'Pushing...' : 'Push Latest' }}
            </button>
            <button
              v-if="prInfo.draft"
              class="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-500 transition-colors disabled:opacity-50"
              :disabled="!!prActionLoading"
              @click="handlePrAction('ready')"
            >
              {{ prActionLoading === 'ready' ? 'Marking...' : 'Ready for Review' }}
            </button>
            <button
              class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-500 transition-colors disabled:opacity-50"
              :disabled="!!prActionLoading"
              @click="handlePrAction('approve')"
            >
              {{ prActionLoading === 'approve' ? 'Approving...' : 'Approve' }}
            </button>
            <button
              class="px-3 py-1.5 text-sm bg-purple-600 text-white rounded hover:bg-purple-500 transition-colors disabled:opacity-50"
              :disabled="!!prActionLoading"
              @click="handlePrAction('merge')"
            >
              {{ prActionLoading === 'merge' ? 'Merging...' : 'Squash Merge' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div v-else class="flex-1 border border-border rounded-lg bg-surface flex items-center justify-center">
      <div class="text-center text-gray-500">
        <div class="text-4xl mb-4">&#x1f50d;</div>
        <div class="text-sm">Select an issue from the sidebar or start a new resolve session.</div>
      </div>
    </div>

    <!-- Create PR modal -->
    <div
      v-if="showCreateModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      @click.self="closeCreateModal"
    >
      <div class="w-full max-w-3xl max-h-[90vh] bg-surface border border-border rounded-lg shadow-xl flex flex-col overflow-hidden">
        <!-- Header -->
        <div class="px-5 py-3 border-b border-border flex items-center justify-between">
          <div>
            <div class="text-white font-semibold text-base">Create Draft PR</div>
            <div class="text-xs text-gray-500 mt-0.5">Review and edit the PR before it's created on GitHub.</div>
          </div>
          <button
            class="text-gray-500 hover:text-white transition-colors text-xl leading-none"
            :disabled="createSubmitting"
            @click="closeCreateModal"
          >×</button>
        </div>

        <!-- Body -->
        <div class="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div v-if="createPreviewLoading" class="text-gray-400 text-sm">
            Loading preview…
          </div>
          <div v-else-if="createPreviewError" class="text-red-400 text-sm">
            {{ createPreviewError }}
          </div>
          <template v-else>
            <!-- Metadata row -->
            <div class="grid grid-cols-2 gap-3 text-xs">
              <div>
                <label class="block text-gray-500 mb-1">Repository</label>
                <div class="bg-surface-dark border border-border rounded px-2 py-1.5 text-gray-300 font-mono truncate">
                  {{ createForm.repo }}
                </div>
              </div>
              <div>
                <label class="block text-gray-500 mb-1">Head branch</label>
                <div class="bg-surface-dark border border-border rounded px-2 py-1.5 text-gray-300 font-mono truncate">
                  {{ createForm.branch }}
                </div>
              </div>
              <div>
                <label class="block text-gray-500 mb-1">Base branch</label>
                <input
                  v-model="createForm.baseBranch"
                  class="w-full bg-surface-dark border border-border rounded px-2 py-1.5 text-gray-200 font-mono focus:outline-none focus:border-blue-500"
                  :disabled="createSubmitting"
                />
              </div>
              <div>
                <label class="block text-gray-500 mb-1">Links issue</label>
                <div class="bg-surface-dark border border-border rounded px-2 py-1.5 text-gray-300 font-mono truncate">
                  {{ createForm.linkRef || '—' }}
                </div>
              </div>
            </div>

            <!-- Title -->
            <div>
              <label class="block text-xs text-gray-500 mb-1">Title</label>
              <input
                v-model="createForm.title"
                class="w-full bg-surface-dark border border-border rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                :disabled="createSubmitting"
              />
            </div>

            <!-- Body -->
            <div>
              <div class="flex items-center justify-between mb-1">
                <label class="block text-xs text-gray-500">Body (Markdown)</label>
                <span class="text-[10px] uppercase tracking-wide text-gray-600">
                  source: {{ createForm.bodySource || 'fallback' }}
                </span>
              </div>
              <textarea
                v-model="createForm.body"
                rows="14"
                class="w-full bg-surface-dark border border-border rounded px-3 py-2 text-xs font-mono text-gray-200 focus:outline-none focus:border-blue-500 resize-y"
                :disabled="createSubmitting"
              />
            </div>

            <!-- Squash hint -->
            <div v-if="createForm.commitCount > 1" class="text-xs text-yellow-400">
              {{ createForm.commitCount }} commits on this branch will be squashed into one before push.
            </div>

            <!-- Result -->
            <div
              v-if="createResult"
              class="border rounded p-3 text-xs font-mono whitespace-pre-wrap overflow-x-auto"
              :class="createResult.ok
                ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-300'
                : 'border-red-500/40 bg-red-500/5 text-red-300'"
            >{{ createResult.output }}</div>
          </template>
        </div>

        <!-- Footer -->
        <div class="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            class="px-3 py-1.5 text-sm bg-surface-dark border border-border text-gray-300 rounded hover:bg-surface hover:text-white transition-colors disabled:opacity-50"
            :disabled="createSubmitting"
            @click="closeCreateModal"
          >Cancel</button>
          <button
            class="px-4 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-500 transition-colors disabled:opacity-50"
            :disabled="createSubmitting || createPreviewLoading || !!createPreviewError || !createForm.title.trim()"
            @click="confirmCreate"
          >
            {{ createSubmitting ? 'Creating…' : 'Create PR' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
