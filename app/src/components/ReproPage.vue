<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import {
  reproSeedTags, reproBriefs, deleteReproBriefRecord,
  fetchGitHubIssues, fetchDefaultIssueLabels,
  type ReproBrief, type ReproIssueEcho, type ReproBriefRecord,
} from '@/api'
import type { GitHubItem } from '@/types'
import { copyToClipboard } from '@/utils/clipboard'

/**
 * /#/repro — reproduce an issue, AI-first.  Two-column layout mirrors
 * ResolvePage: left sidebar = analyzed-issue history + GitHub picker +
 * backend + analyze controls; right main = the brief / live analysis.
 *
 * Flow: pick issue (GitHub list / paste) → tags seeded from labels →
 * pick AI backend → Analyze (streamed) → brief.  Every analysis is
 * persisted, so the sidebar history is reviewable later without
 * re-spending an AI call.
 */

const issueInput = ref('')
const issue = ref<ReproIssueEcho | null>(null)
const tags = ref<string[]>([])
const newTag = ref('')
const selectedBackend = ref<'claude' | 'codex'>('claude')

// --- Persisted history (sidebar listing) ---
const history = ref<ReproBriefRecord[]>([])
const selectedIssue = ref<string>('')   // issue number currently shown in main

async function loadHistory() {
  try {
    const r = await reproBriefs()
    if (r.ok) history.value = r.briefs
  } catch { /* ignore */ }
}
onMounted(loadHistory)

function openHistory(rec: ReproBriefRecord) {
  // Re-display a past analysis without re-running.
  issue.value = { number: rec.issue, title: rec.title, htmlUrl: rec.htmlUrl, labels: rec.labels }
  tags.value = [...rec.tags]
  brief.value = rec.brief
  selectedIssue.value = rec.issue
  logLines.value = []
  progress.value = null
  error.value = ''
}

async function removeHistory(rec: ReproBriefRecord) {
  await deleteReproBriefRecord(rec.issue).catch(() => undefined)
  if (selectedIssue.value === rec.issue) { brief.value = null; selectedIssue.value = '' }
  loadHistory()
}

// --- Browse-GitHub picker (mirrors ResolvePage) ---
const ghShow = ref(false)
const ghItems = ref<GitHubItem[]>([])
const ghLoading = ref(false)
const ghError = ref('')
const ghDefaultLabels = ref<string[]>([])
const ghSelectedLabels = ref<string[]>([])
let ghDefaultsLoaded = false

async function toggleGhPicker() {
  ghShow.value = !ghShow.value
  if (ghShow.value && ghItems.value.length === 0 && !ghLoading.value) await refreshGh()
}
async function refreshGh() {
  ghLoading.value = true
  ghError.value = ''
  try {
    if (!ghDefaultsLoaded) {
      ghDefaultLabels.value = await fetchDefaultIssueLabels()
      ghSelectedLabels.value = [...ghDefaultLabels.value]
      ghDefaultsLoaded = true
    }
    const result = await fetchGitHubIssues(undefined, ghSelectedLabels.value)
    if (result.error) {
      ghError.value = result.error === 'auth_required'
        ? 'GitHub authentication required (Dashboard → GitHub).'
        : result.error
      ghItems.value = []
    } else {
      // Issues only — not PRs (review-requested items ARE pull requests).
      ghItems.value = (result.items || []).filter((it) => it.category === 'assigned' && !it.isPR)
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
function pickGhItem(item: GitHubItem) {
  issueInput.value = String(item.number)
  ghShow.value = false
  loadIssue()
}

// --- Issue load (seed tags) ---
const loadingIssue = ref(false)
async function loadIssue() {
  const ref_ = issueInput.value.trim()
  if (!ref_) return
  loadingIssue.value = true
  error.value = ''
  brief.value = null
  selectedIssue.value = ''
  try {
    const r = await reproSeedTags(ref_)
    if (!r.ok || !r.issue) {
      error.value = r.error || 'Could not fetch issue.'
      issue.value = null
      return
    }
    issue.value = r.issue
    tags.value = r.tags || []
  } catch (e: any) {
    error.value = e?.message || 'Request failed.'
  } finally {
    loadingIssue.value = false
  }
}

function addTag() {
  const t = newTag.value.trim().toLowerCase()
  if (t && !tags.value.includes(t)) tags.value.push(t)
  newTag.value = ''
}
function removeTag(t: string) { tags.value = tags.value.filter((x) => x !== t) }

// --- Analyze (SSE: logs + progress) ---
const analyzing = ref(false)
const error = ref('')
const rawOutput = ref('')
const brief = ref<ReproBrief | null>(null)
const logLines = ref<string[]>([])
const progress = ref<{ phase: number; total: number; label: string } | null>(null)
const logPanel = ref<HTMLElement | null>(null)
let analyzeSource: EventSource | null = null
const progressPct = computed(() =>
  progress.value ? Math.round((progress.value.phase / progress.value.total) * 100) : 0,
)

async function pushLog(line: string) {
  logLines.value.push(line)
  await nextTick()
  if (logPanel.value) logPanel.value.scrollTop = logPanel.value.scrollHeight
}

function analyze() {
  if (!issue.value || analyzing.value) return
  analyzing.value = true
  error.value = ''
  rawOutput.value = ''
  brief.value = null
  logLines.value = []
  progress.value = { phase: 0, total: 4, label: 'Starting…' }
  selectedIssue.value = issue.value.number

  const params = new URLSearchParams({ issue: issue.value.number, backend: selectedBackend.value })
  if (tags.value.length) params.set('tags', tags.value.join(','))
  analyzeSource = new EventSource(`/api/repro/analyze/stream?${params}`)

  analyzeSource.addEventListener('log', (e) => {
    try { void pushLog(JSON.parse((e as MessageEvent).data).line) } catch { /* ignore */ }
  })
  analyzeSource.addEventListener('progress', (e) => {
    try { progress.value = JSON.parse((e as MessageEvent).data) } catch { /* ignore */ }
  })
  analyzeSource.addEventListener('brief', (e) => {
    try {
      brief.value = JSON.parse((e as MessageEvent).data).brief
      progress.value = { phase: 4, total: 4, label: 'Done' }
      loadHistory()   // newly recorded analysis shows in the sidebar
    } catch { error.value = 'Failed to parse brief.' }
    finishAnalyze()
  })
  analyzeSource.addEventListener('error', (e) => {
    const data = (e as MessageEvent).data
    if (data) {
      try { const r = JSON.parse(data); error.value = r.message || 'Analysis failed.'; rawOutput.value = r.rawOutput || '' }
      catch { error.value = 'Analysis failed.' }
    } else if (analyzing.value && !brief.value) {
      error.value = 'Connection lost during analysis.'
    }
    finishAnalyze()
  })
}
function finishAnalyze() {
  if (analyzeSource) { analyzeSource.close(); analyzeSource = null }
  analyzing.value = false
}
onUnmounted(() => { if (analyzeSource) analyzeSource.close() })

// Hand-off to the Resolve page.  The skip-Step-1 behaviour is entirely
// server-side (resolve looks up this issue's persisted brief), so this
// just navigates.  We also stash the issue so a future resolve-page
// tweak can pre-fill its input; today the user re-picks the issue there
// and the server still injects the repro context automatically.
function resolveThisIssue() {
  if (!issue.value) return
  try { localStorage.setItem('swctl.resolve.prefillIssue', issue.value.number) } catch { /* ignore */ }
  // /resolve is a plugin-registered route; hash navigation reaches it.
  window.location.assign(`${window.location.pathname}${window.location.search}#/resolve`)
}

const message = ref('')
async function copyText(s: string) {
  message.value = (await copyToClipboard(s)) ? 'Copied.' : 'Clipboard unavailable.'
  setTimeout(() => { message.value = '' }, 1500)
}

function badgeClass(category: string) {
  switch (category) {
    case 'api':             return 'bg-sky-500/15 text-sky-300'
    case 'search':          return 'bg-violet-500/15 text-violet-300'
    case 'storefront-html': return 'bg-emerald-500/15 text-emerald-300'
    case 'console':         return 'bg-orange-500/15 text-orange-300'
    case 'admin-ui':        return 'bg-rose-500/15 text-rose-300'
    default:                return 'bg-gray-500/15 text-gray-300'
  }
}
function feasClass(f: string) {
  return f === 'auto' ? 'bg-emerald-500/15 text-emerald-300'
    : f === 'partial' ? 'bg-amber-500/15 text-amber-300'
    : 'bg-gray-500/15 text-gray-400'
}
function feasLabel(f: string) {
  return f === 'auto' ? 'fully automatable' : f === 'partial' ? 'partially automatable' : 'manual checklist'
}
</script>

<template>
  <div class="flex gap-4 h-[calc(100vh-120px)]">
    <!-- Left sidebar: history + analyze controls -->
    <div class="w-72 flex-shrink-0 border border-border rounded-lg bg-surface overflow-hidden flex flex-col">
      <div class="px-3 py-2 border-b border-border flex items-center justify-between">
        <span class="text-sm font-semibold text-white">Analyzed issues</span>
        <span class="text-xs text-gray-500">{{ history.length }}</span>
      </div>

      <!-- History listing (persisted, reviewable later) -->
      <div class="overflow-y-auto flex-1">
        <div v-if="history.length === 0" class="px-3 py-4 text-xs text-gray-500 leading-relaxed">
          <p class="text-gray-400 mb-2">No analyses yet.</p>
          <p>Pick an issue from <button class="text-blue-400 hover:text-blue-300"
             @click="ghShow ? null : toggleGhPicker()">Browse GitHub</button> below, then Analyze.</p>
        </div>
        <div
          v-for="rec in history"
          :key="rec.issue"
          class="w-full text-left px-3 py-2 border-b border-border/50 transition-colors cursor-pointer group"
          :class="selectedIssue === rec.issue
            ? 'bg-blue-500/10 border-l-2 border-l-blue-400'
            : 'hover:bg-surface-dark'"
          @click="openHistory(rec)"
        >
          <div class="flex items-center gap-1.5">
            <span class="text-blue-400 font-mono text-[11px]">#{{ rec.issue }}</span>
            <span class="px-1 rounded text-[9px]" :class="badgeClass(rec.category)">{{ rec.category }}</span>
            <span class="px-1 rounded text-[9px]" :class="feasClass(rec.feasibility)">{{ rec.feasibility }}</span>
            <button
              class="ml-auto text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 text-xs"
              title="Remove from history" @click.stop="removeHistory(rec)"
            >×</button>
          </div>
          <div class="text-xs text-gray-300 truncate mt-0.5">{{ rec.title }}</div>
          <div class="text-[10px] text-gray-600 mt-0.5">
            {{ rec.project || 'platform' }}<span v-if="rec.enableEs"> · ES</span> · {{ rec.backend }}
          </div>
        </div>
      </div>

      <!-- Browse GitHub (issues only) -->
      <div class="border-t border-border">
        <button class="w-full px-3 py-1.5 text-xs text-left text-gray-400 hover:text-white flex items-center justify-between"
                @click="toggleGhPicker">
          <span>{{ ghShow ? '▾' : '▸' }} Browse GitHub</span>
          <span v-if="ghShow && ghItems.length > 0" class="text-[10px] text-gray-600">{{ ghItems.length }}</span>
        </button>
        <div v-if="ghShow" class="px-2 pb-2">
          <div v-if="ghDefaultLabels.length > 0" class="flex items-center flex-wrap gap-1 mb-2">
            <span v-for="label in ghSelectedLabels" :key="label"
                  class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-600/20 text-blue-300 border border-blue-600/40">
              {{ label }}
              <button class="text-blue-300/70 hover:text-white text-[11px] leading-none"
                      @click="removeGhLabel(label)">×</button>
            </span>
            <button v-if="ghSelectedLabels.length < ghDefaultLabels.length"
                    class="text-[10px] px-1.5 py-0.5 rounded-full border border-border text-gray-500 hover:text-gray-300"
                    @click="resetGhLabels">Reset</button>
          </div>
          <div v-if="ghLoading" class="text-xs text-gray-500 italic px-1 py-2">Loading…</div>
          <div v-else-if="ghError" class="text-xs text-red-400 px-1 py-2">{{ ghError }}</div>
          <div v-else-if="ghItems.length === 0" class="text-xs text-gray-600 italic px-1 py-2">No issues match.</div>
          <div v-else class="max-h-44 overflow-y-auto border border-border rounded bg-surface-dark">
            <button v-for="item in ghItems" :key="`${item.repo}#${item.number}`"
                    class="w-full text-left px-2 py-1.5 text-xs border-b border-border/50 last:border-b-0 hover:bg-surface"
                    :title="item.title" @click="pickGhItem(item)">
              <div class="text-blue-400 font-mono text-[11px]">#{{ item.number }}</div>
              <div class="text-gray-300 truncate">{{ item.title }}</div>
            </button>
          </div>
        </div>
      </div>

      <!-- Paste + backend + analyze -->
      <div class="p-2 border-t border-border">
        <div class="flex gap-1">
          <input v-model="issueInput" placeholder="Issue URL or #number"
                 class="flex-1 bg-surface-dark border border-border rounded px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                 @keydown.enter="loadIssue" />
          <button class="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50"
                  :disabled="loadingIssue || !issueInput.trim()" @click="loadIssue">
            {{ loadingIssue ? '…' : 'Load' }}
          </button>
        </div>
        <div class="flex items-center gap-2 mt-1.5 text-[11px] text-gray-500">
          <span>AI:</span>
          <label class="flex items-center gap-1 cursor-pointer select-none">
            <input v-model="selectedBackend" type="radio" value="claude" class="accent-blue-500" />
            <span :class="selectedBackend === 'claude' ? 'text-gray-200' : ''">Claude</span>
          </label>
          <label class="flex items-center gap-1 cursor-pointer select-none">
            <input v-model="selectedBackend" type="radio" value="codex" class="accent-blue-500" />
            <span :class="selectedBackend === 'codex' ? 'text-gray-200' : ''">Codex</span>
          </label>
          <span v-if="selectedBackend === 'codex'" class="ml-auto text-amber-500/80"
                title="Codex one-shot analyze; experimental.">experimental</span>
        </div>
      </div>
    </div>

    <!-- Right main: brief / live analysis -->
    <div class="flex-1 border border-border rounded-lg bg-surface overflow-hidden flex flex-col">
      <div v-if="!issue && !analyzing" class="flex-1 flex items-center justify-center text-sm text-gray-600">
        Pick an issue from the sidebar to analyze, or open a past analysis.
      </div>

      <div v-else class="flex-1 overflow-y-auto p-5 space-y-4">
        <!-- Selected issue header + tags + analyze -->
        <div v-if="issue">
          <a :href="issue.htmlUrl" target="_blank" rel="noopener" class="text-sm text-sky-300 hover:underline font-medium">
            #{{ issue.number }} — {{ issue.title }}
          </a>
          <div class="mt-1 flex flex-wrap gap-1">
            <span v-for="l in issue.labels" :key="l" class="px-1.5 py-0.5 text-[10px] rounded bg-gray-700 text-gray-300">{{ l }}</span>
          </div>
          <div class="mt-3">
            <div class="text-xs font-medium text-gray-300 mb-1">Focus tags <span class="text-gray-500 font-normal">— steer the analysis</span></div>
            <div class="flex flex-wrap items-center gap-2">
              <span v-for="t in tags" :key="t" class="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-sky-500/15 text-sky-200">
                {{ t }}<button class="text-sky-400 hover:text-white" @click="removeTag(t)">×</button>
              </span>
              <input v-model="newTag" placeholder="+ tag"
                     class="w-24 px-2 py-0.5 text-xs rounded bg-surface-dark border border-border text-white placeholder-gray-600 focus:outline-none focus:border-sky-500"
                     @keydown.enter.prevent="addTag" />
            </div>
          </div>
          <div class="mt-3 flex items-center gap-3">
            <button class="px-4 py-1.5 text-sm rounded font-medium bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-50"
                    :disabled="analyzing" @click="analyze">
              <span v-if="analyzing" class="inline-block w-3 h-3 mr-1 border-2 border-white border-t-transparent rounded-full animate-spin" />
              {{ analyzing ? 'Analyzing…' : (brief ? 'Re-analyze' : 'Analyze with AI') }}
            </button>
            <span v-if="message" class="text-xs text-gray-400">{{ message }}</span>
          </div>
        </div>

        <!-- Live progress + log -->
        <div v-if="analyzing || logLines.length" class="space-y-2">
          <div class="flex items-center justify-between text-xs">
            <span class="font-medium text-gray-300">
              {{ progress?.label || 'Analyzing' }}
              <span v-if="progress" class="text-gray-500">· step {{ progress.phase }}/{{ progress.total }}</span>
            </span>
          </div>
          <div class="h-1.5 rounded-full bg-surface-dark overflow-hidden">
            <div class="h-full rounded-full transition-all duration-500" :class="brief ? 'bg-emerald-500' : 'bg-sky-500'" :style="{ width: progressPct + '%' }" />
          </div>
          <div ref="logPanel" class="max-h-40 overflow-y-auto rounded bg-surface-dark border border-border p-2 font-mono text-[11px] leading-5 text-gray-400">
            <div v-for="(line, i) in logLines" :key="i" class="whitespace-pre-wrap">{{ line }}</div>
          </div>
        </div>

        <div v-if="error" class="text-sm text-red-400 border border-red-500/30 bg-red-500/10 rounded px-3 py-2">
          {{ error }}
          <pre v-if="rawOutput" class="mt-2 text-[10px] text-gray-500 whitespace-pre-wrap max-h-40 overflow-y-auto">{{ rawOutput }}</pre>
        </div>

        <!-- Brief -->
        <div v-if="brief" class="space-y-4">
          <div class="flex items-center gap-2 flex-wrap">
            <h3 class="text-sm font-semibold text-white">Repro brief</h3>
            <span class="px-2 py-0.5 rounded text-xs" :class="badgeClass(brief.category)">{{ brief.category }}</span>
            <span class="px-2 py-0.5 rounded text-xs" :class="feasClass(brief.feasibility)">{{ feasLabel(brief.feasibility) }}</span>
          </div>
          <p class="text-sm text-gray-200">{{ brief.summary }}</p>

          <div class="rounded border border-border bg-surface-dark p-3 text-xs space-y-1">
            <div class="font-medium text-gray-300 mb-1">Instance requirements</div>
            <div class="flex gap-4 text-gray-400">
              <span>Elasticsearch: <span :class="brief.instanceNeeds.enableEs ? 'text-amber-300' : 'text-gray-300'">{{ brief.instanceNeeds.enableEs ? 'required' : 'not needed' }}</span></span>
              <span>Project: <span class="text-gray-300">{{ brief.instanceNeeds.project || 'platform / trunk' }}</span></span>
            </div>
            <div v-if="brief.instanceNeeds.notes" class="text-gray-500">{{ brief.instanceNeeds.notes }}</div>
          </div>

          <div class="grid md:grid-cols-2 gap-3">
            <div v-for="(items, label) in {
                   'Preconditions': brief.preconditions, 'Setup steps': brief.setup,
                   'Execute': brief.execute, 'Checks (expected vs bug)': brief.checks,
                 }" :key="label" class="rounded border border-border bg-surface-dark p-3">
              <div class="text-xs font-medium text-gray-300 mb-2">{{ label }}</div>
              <ol class="space-y-1 text-xs text-gray-400 list-decimal list-inside">
                <li v-for="(s, i) in items" :key="i">{{ s }}</li>
                <li v-if="!items.length" class="list-none text-gray-600">(none)</li>
              </ol>
            </div>
          </div>

          <div v-if="brief.scenarioYaml" class="rounded border border-border bg-surface-dark p-3">
            <div class="flex items-center justify-between mb-2">
              <div class="text-xs font-medium text-gray-300">Draft scenario — <code>.swctl/repro.yml</code> <span class="text-gray-500 font-normal">(headless)</span></div>
              <button class="px-2 py-0.5 text-[11px] rounded bg-gray-700 hover:bg-gray-600 text-gray-100" @click="copyText(brief.scenarioYaml)">Copy</button>
            </div>
            <pre class="text-[11px] text-gray-300 whitespace-pre-wrap max-h-80 overflow-y-auto font-mono">{{ brief.scenarioYaml }}</pre>
          </div>

          <div v-if="brief.playwrightSpec" class="rounded border border-rose-500/30 bg-rose-500/5 p-3">
            <div class="flex items-center justify-between mb-2">
              <div class="text-xs font-medium text-gray-300">📸 Draft e2e spec — <code>.swctl/repro.spec.ts</code> <span class="text-gray-500 font-normal">(Playwright)</span></div>
              <button class="px-2 py-0.5 text-[11px] rounded bg-gray-700 hover:bg-gray-600 text-gray-100" @click="copyText(brief.playwrightSpec)">Copy</button>
            </div>
            <pre class="text-[11px] text-gray-300 whitespace-pre-wrap max-h-80 overflow-y-auto font-mono">{{ brief.playwrightSpec }}</pre>
          </div>

          <div v-if="brief.notes" class="text-xs text-gray-500 border-l-2 border-gray-600 pl-3">{{ brief.notes }}</div>

          <div class="flex items-center gap-3 pt-1">
            <button class="px-4 py-1.5 text-sm rounded font-medium bg-gray-700 text-gray-400 cursor-not-allowed" disabled
                    title="Coming next: create the instance with these requirements + run the scenario">
              Create instance + run repro (soon)
            </button>
            <!-- Hand-off to resolve: skips Step 1 (the server detects this
                 issue's persisted brief and injects "reproduction done,
                 start at root cause" into the resolve prompt). -->
            <button class="px-4 py-1.5 text-sm rounded font-medium bg-blue-600 hover:bg-blue-500 text-white"
                    title="Open the Resolve page for this issue. Resolve will skip its own reproduction step (Step 1) and re-use this scenario to verify the fix."
                    @click="resolveThisIssue">
              Resolve this issue →
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
