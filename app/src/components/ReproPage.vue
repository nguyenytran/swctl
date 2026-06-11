<script setup lang="ts">
import { ref, computed } from 'vue'
import { reproAnalyze, reproSeedTags, type ReproBrief, type ReproIssueEcho } from '@/api'
import { copyToClipboard } from '@/utils/clipboard'

/**
 * /#/repro — reproduce an issue, AI-first.
 *
 * Flow (designed 2026-06-12):
 *   1. Pick an issue (number or URL) → seed-tags fetches title/labels
 *      and pre-ticks focus tags derived from the labels.
 *   2. Adjust tags — they steer the AI's attention ("search", "UI",
 *      "pricing", …).
 *   3. Analyze → one-shot AI call (15-40 s) → structured repro brief:
 *      what the bug is, what the instance needs (ES? plugin?), setup /
 *      execute / check steps, and — when feasible — a draft
 *      .swctl/repro.yml the `swctl repro` runner can execute.
 *   4. (next slice) Create instance from the brief + run the scenario.
 *
 * For admin-ui issues the brief degrades gracefully to a structured
 * MANUAL checklist (feasibility=manual) — still answers "what needs
 * to be reproduced, what needs to be checked".
 */

const issueInput = ref('')
const issue = ref<ReproIssueEcho | null>(null)
const tags = ref<string[]>([])
const newTag = ref('')

const loadingIssue = ref(false)
const analyzing = ref(false)
const error = ref('')
const rawOutput = ref('')
const brief = ref<ReproBrief | null>(null)

async function loadIssue() {
  const ref_ = issueInput.value.trim()
  if (!ref_) return
  loadingIssue.value = true
  error.value = ''
  brief.value = null
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
function removeTag(t: string) {
  tags.value = tags.value.filter((x) => x !== t)
}

async function analyze() {
  if (!issue.value) return
  analyzing.value = true
  error.value = ''
  rawOutput.value = ''
  brief.value = null
  try {
    const r = await reproAnalyze(issue.value.number, tags.value)
    if (!r.ok || !r.brief) {
      error.value = r.error || 'Analysis failed.'
      rawOutput.value = r.rawOutput || ''
      return
    }
    brief.value = r.brief
  } catch (e: any) {
    error.value = e?.message || 'Request failed.'
  } finally {
    analyzing.value = false
  }
}

const message = ref('')
async function copyText(s: string) {
  message.value = (await copyToClipboard(s)) ? 'Copied.' : 'Clipboard unavailable.'
  setTimeout(() => { message.value = '' }, 1500)
}

const categoryColor = computed(() => {
  switch (brief.value?.category) {
    case 'api':              return 'bg-sky-500/15 text-sky-300'
    case 'search':           return 'bg-violet-500/15 text-violet-300'
    case 'storefront-html':  return 'bg-emerald-500/15 text-emerald-300'
    case 'console':          return 'bg-orange-500/15 text-orange-300'
    case 'admin-ui':         return 'bg-rose-500/15 text-rose-300'
    default:                 return 'bg-gray-500/15 text-gray-300'
  }
})
const feasibilityColor = computed(() => {
  switch (brief.value?.feasibility) {
    case 'auto':    return 'bg-emerald-500/15 text-emerald-300'
    case 'partial': return 'bg-amber-500/15 text-amber-300'
    default:        return 'bg-gray-500/15 text-gray-400'
  }
})
</script>

<template>
  <div class="max-w-4xl mx-auto p-6 space-y-6">
    <header>
      <h2 class="text-xl font-bold text-white">Reproduce an issue</h2>
      <p class="text-xs text-gray-500 mt-1">
        Pick an issue, add focus tags, and let the AI draft the reproduction plan —
        what the instance needs, what to set up, what to check.  Runnable scenarios
        execute via <code class="text-gray-300">swctl repro</code>; UI-only issues get a manual checklist.
      </p>
    </header>

    <!-- 1. Issue picker -->
    <section class="border border-border rounded-lg bg-surface p-4 space-y-3">
      <div class="text-xs font-medium text-gray-300">Issue</div>
      <div class="flex gap-2">
        <input
          v-model="issueInput"
          type="text"
          spellcheck="false"
          placeholder="issue number or GitHub URL — e.g. 10833"
          class="flex-1 px-3 py-1.5 text-sm font-mono rounded bg-surface-dark border border-border text-white placeholder-gray-600 focus:outline-none focus:border-sky-500"
          @keydown.enter.prevent="loadIssue"
        />
        <button
          class="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
          :disabled="loadingIssue || !issueInput.trim()"
          @click="loadIssue"
        >{{ loadingIssue ? 'Loading…' : 'Load' }}</button>
      </div>

      <div v-if="issue" class="rounded border border-border bg-surface-dark p-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <a :href="issue.htmlUrl" target="_blank" rel="noopener"
               class="text-sm text-sky-300 hover:underline font-medium">
              #{{ issue.number }} — {{ issue.title }}
            </a>
            <div class="mt-1 flex flex-wrap gap-1">
              <span v-for="l in issue.labels" :key="l"
                    class="px-1.5 py-0.5 text-[10px] rounded bg-gray-700 text-gray-300">{{ l }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 2. Tags -->
    <section v-if="issue" class="border border-border rounded-lg bg-surface p-4 space-y-3">
      <div class="text-xs font-medium text-gray-300">
        Focus tags
        <span class="text-gray-500 font-normal">— steer the analysis (seeded from labels; add your own)</span>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <span v-for="t in tags" :key="t"
              class="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-sky-500/15 text-sky-200">
          {{ t }}
          <button class="text-sky-400 hover:text-white" @click="removeTag(t)">×</button>
        </span>
        <input
          v-model="newTag"
          type="text"
          spellcheck="false"
          placeholder="+ add tag"
          class="w-28 px-2 py-0.5 text-xs rounded bg-surface-dark border border-border text-white placeholder-gray-600 focus:outline-none focus:border-sky-500"
          @keydown.enter.prevent="addTag"
        />
      </div>
      <div class="flex items-center gap-3 pt-1">
        <button
          class="px-4 py-1.5 text-sm rounded font-medium bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-50"
          :disabled="analyzing"
          @click="analyze"
        >
          <span v-if="analyzing" class="inline-block w-3 h-3 mr-1 border-2 border-white border-t-transparent rounded-full animate-spin" />
          {{ analyzing ? 'Analyzing… (15–40 s)' : 'Analyze with AI' }}
        </button>
        <span v-if="message" class="text-xs text-gray-400">{{ message }}</span>
      </div>
    </section>

    <!-- Errors -->
    <div v-if="error" class="text-sm text-red-400 border border-red-500/30 bg-red-500/10 rounded px-3 py-2">
      {{ error }}
      <pre v-if="rawOutput" class="mt-2 text-[10px] text-gray-500 whitespace-pre-wrap max-h-40 overflow-y-auto">{{ rawOutput }}</pre>
    </div>

    <!-- 3. Brief -->
    <section v-if="brief" class="border border-border rounded-lg bg-surface p-4 space-y-4">
      <header class="flex items-center gap-2 flex-wrap">
        <h3 class="text-sm font-semibold text-white">Repro brief</h3>
        <span class="px-2 py-0.5 rounded text-xs" :class="categoryColor">{{ brief.category }}</span>
        <span class="px-2 py-0.5 rounded text-xs" :class="feasibilityColor">
          {{ brief.feasibility === 'auto' ? 'fully automatable'
             : brief.feasibility === 'partial' ? 'partially automatable'
             : 'manual checklist' }}
        </span>
      </header>

      <p class="text-sm text-gray-200">{{ brief.summary }}</p>

      <!-- Instance needs -->
      <div class="rounded border border-border bg-surface-dark p-3 text-xs space-y-1">
        <div class="font-medium text-gray-300 mb-1">Instance requirements</div>
        <div class="flex gap-4 text-gray-400">
          <span>Elasticsearch: <span :class="brief.instanceNeeds.enableEs ? 'text-amber-300' : 'text-gray-300'">{{ brief.instanceNeeds.enableEs ? 'required' : 'not needed' }}</span></span>
          <span>Project: <span class="text-gray-300">{{ brief.instanceNeeds.project || 'platform / trunk' }}</span></span>
        </div>
        <div v-if="brief.instanceNeeds.notes" class="text-gray-500">{{ brief.instanceNeeds.notes }}</div>
      </div>

      <!-- Plan lists -->
      <div class="grid md:grid-cols-2 gap-3">
        <div v-for="(items, label) in {
               'Preconditions': brief.preconditions,
               'Setup steps': brief.setup,
               'Execute': brief.execute,
               'Checks (expected vs bug)': brief.checks,
             }" :key="label"
             class="rounded border border-border bg-surface-dark p-3">
          <div class="text-xs font-medium text-gray-300 mb-2">{{ label }}</div>
          <ol class="space-y-1 text-xs text-gray-400 list-decimal list-inside">
            <li v-for="(s, i) in items" :key="i">{{ s }}</li>
            <li v-if="!items.length" class="list-none text-gray-600">(none)</li>
          </ol>
        </div>
      </div>

      <!-- Scenario draft -->
      <div v-if="brief.scenarioYaml" class="rounded border border-border bg-surface-dark p-3">
        <div class="flex items-center justify-between mb-2">
          <div class="text-xs font-medium text-gray-300">Draft scenario — <code>.swctl/repro.yml</code></div>
          <button class="px-2 py-0.5 text-[11px] rounded bg-gray-700 hover:bg-gray-600 text-gray-100"
                  @click="copyText(brief.scenarioYaml)">Copy</button>
        </div>
        <pre class="text-[11px] text-gray-300 whitespace-pre-wrap max-h-80 overflow-y-auto font-mono">{{ brief.scenarioYaml }}</pre>
      </div>

      <div v-if="brief.notes" class="text-xs text-gray-500 border-l-2 border-gray-600 pl-3">
        {{ brief.notes }}
      </div>

      <!-- Execute (next slice) -->
      <div class="flex items-center gap-3 pt-1">
        <button
          class="px-4 py-1.5 text-sm rounded font-medium bg-gray-700 text-gray-400 cursor-not-allowed"
          disabled
          title="Coming next: create the instance with these requirements (ES, project) and run the scenario via swctl repro"
        >Create instance + run repro (soon)</button>
        <button
          class="px-3 py-1.5 text-sm rounded bg-surface-dark text-gray-300 hover:text-white border border-border"
          :disabled="analyzing"
          @click="analyze"
        >Re-analyze</button>
      </div>
    </section>
  </div>
</template>
