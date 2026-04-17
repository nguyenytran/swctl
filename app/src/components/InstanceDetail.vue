<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import type { Instance, StreamEvent } from '@/types'
import { useStream } from '@/composables/useStream'
import { stopInstance, startInstance, restartInstance, buildStreamUrl, killExec, killWorktreeExec, fetchDiff, setupInstance } from '@/api'
import { usePlugins } from '@/composables/usePlugins'
import { useFeatures } from '@/composables/useFeatures'
import PluginSlot from './PluginSlot.vue'

const props = defineProps<{ instance: Instance }>()
const emit = defineEmits<{ close: []; refresh: [] }>()

// Feature flag: the "Submit Review" diff-tab action uses Claude Code via
// the resolve skill.  Hidden unless SWCTL_RESOLVE_ENABLED=1 on the server.
const { features } = useFeatures()

type BuiltinTab = 'logs' | 'exec' | 'worktree' | 'diff' | 'info'
type TabName = BuiltinTab | string  // plugin tabs use `plugin:<pluginId>:<tabId>`

const pluginsApi = usePlugins()

const activeTab = ref<TabName>('logs')

interface UiTab { id: TabName; label: string; isPlugin?: boolean; pluginId?: string; tabId?: string }

const availableTabs = computed<UiTab[]>(() => {
  const tabs: UiTab[] = [
    { id: 'logs', label: 'Logs' },
    { id: 'exec', label: 'Console' },
  ]
  if (props.instance.worktreePath) tabs.push({ id: 'worktree', label: 'Worktree' })
  if (props.instance.worktreePath) tabs.push({ id: 'diff', label: 'Diff' })
  tabs.push({ id: 'info', label: 'Info' })

  // Append plugin-provided tabs (respecting each plugin's `condition`)
  for (const t of pluginsApi.tabs.value) {
    if (t.condition && !t.condition(props.instance)) continue
    tabs.push({
      id: `plugin:${t.pluginId}:${t.id}`,
      label: t.label,
      isPlugin: true,
      pluginId: t.pluginId,
      tabId: t.id,
    })
  }
  return tabs
})

const activePluginTab = computed(() => {
  const found = availableTabs.value.find(t => t.id === activeTab.value)
  if (!found?.isPlugin) return null
  return pluginsApi.tabs.value.find(t => t.pluginId === found.pluginId && t.id === found.tabId) || null
})
const logStream = useStream()
const execStream = useStream()
const wtStream = useStream()
const isRefreshing = ref(false)
const isCheckingOut = ref(false)
const cmdInput = ref('')
const cmdHistory = ref<Array<{ command: string; lines: StreamEvent[]; exitCode: number | null }>>([])
const terminalEl = ref<HTMLElement | null>(null)
const wtCmdInput = ref('')
const wtCmdHistory = ref<Array<{ command: string; lines: StreamEvent[]; exitCode: number | null }>>([])
const wtTerminalEl = ref<HTMLElement | null>(null)


// Diff state
const diffStat = ref('')
const diffContent = ref('')
const diffLoading = ref(false)
const diffLoaded = ref(false)
// Server-reported scope of the diff (differs for plugin-external vs platform)
const diffBaseRef = ref('')
const diffCwd = ref('')

interface DiffLine {
  type: 'add' | 'del' | 'context' | 'hunk-header' | 'file-header'
  content: string
  oldLine: number | null
  newLine: number | null
}
interface DiffHunk { header: string; lines: DiffLine[] }
interface DiffFile { path: string; hunks: DiffHunk[]; additions: number; deletions: number; collapsed: boolean }
interface ReviewComment { file: string; line: number; lineContent: string; comment: string }

const parsedFiles = ref<DiffFile[]>([])
const reviewComments = ref<ReviewComment[]>([])
const commentingAt = ref<{ file: string; line: number; content: string } | null>(null)
const commentInput = ref('')
const reviewStream = useStream()
const reviewSubmitting = ref(false)
const reviewBanner = ref<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null)
const reviewCommittedSha = ref('')

function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldLine = 0, newLine = 0

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git')) {
      const m = line.match(/b\/(.+)$/)
      current = { path: m?.[1] || '?', hunks: [], additions: 0, deletions: 0, collapsed: false }
      files.push(current)
      hunk = null
      continue
    }
    if (!current) continue
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) continue

    if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      oldLine = m ? parseInt(m[1]) : 0
      newLine = m ? parseInt(m[2]) : 0
      hunk = { header: line, lines: [{ type: 'hunk-header', content: line, oldLine: null, newLine: null }] }
      current.hunks.push(hunk)
      continue
    }
    if (!hunk) continue

    if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', content: line.slice(1), oldLine: null, newLine: newLine++ })
      current.additions++
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: 'del', content: line.slice(1), oldLine: oldLine++, newLine: null })
      current.deletions++
    } else {
      hunk.lines.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : line, oldLine: oldLine++, newLine: newLine++ })
    }
  }
  return files
}

async function loadDiff() {
  diffLoading.value = true
  diffLoaded.value = false
  try {
    const result = await fetchDiff(props.instance.issueId)
    diffStat.value = result.stat || ''
    diffContent.value = result.diff || ''
    diffBaseRef.value = (result as any).baseRef || props.instance.baseRef || ''
    diffCwd.value = (result as any).cwd || props.instance.worktreePath || ''
    parsedFiles.value = parseDiff(result.diff || '')
    diffLoaded.value = true
  } catch {
    diffContent.value = ''
    diffStat.value = ''
    parsedFiles.value = []
  } finally {
    diffLoading.value = false
  }
}

function startComment(file: string, line: number, content: string) {
  commentingAt.value = { file, line, content }
  commentInput.value = ''
}

function addComment() {
  if (!commentingAt.value || !commentInput.value.trim()) return
  reviewComments.value.push({
    file: commentingAt.value.file,
    line: commentingAt.value.line,
    lineContent: commentingAt.value.content,
    comment: commentInput.value.trim(),
  })
  commentingAt.value = null
  commentInput.value = ''
}

function cancelComment() {
  commentingAt.value = null
  commentInput.value = ''
}

function removeComment(idx: number) {
  reviewComments.value.splice(idx, 1)
}

function hasCommentAt(file: string, line: number): ReviewComment | undefined {
  return reviewComments.value.find(c => c.file === file && c.line === line)
}

async function submitReview() {
  if (reviewComments.value.length === 0) return
  reviewSubmitting.value = true

  // Determine the git directory Claude should edit & commit into.  For
  // plugin-external instances the fix commit lives in the nested plugin
  // worktree, not the trunk worktree.  Mirrors the prAction() logic.
  const inst = props.instance as any
  const gitCwd = (inst.projectType === 'plugin-external' && inst.pluginName)
    ? `${props.instance.worktreePath}/custom/plugins/${inst.pluginName}`
    : props.instance.worktreePath

  // Build a map of { file → { line → { content, hunk } } } so we can
  // enrich the prompt with the actual line text + surrounding context.
  function contextWindow(filePath: string, targetLine: number, radius = 3): string[] {
    const file = parsedFiles.value.find(f => f.path === filePath)
    if (!file) return []
    const picked: string[] = []
    for (const hunk of file.hunks) {
      for (const l of hunk.lines) {
        const num = l.newLine ?? l.oldLine
        if (num == null) continue
        if (num >= targetLine - radius && num <= targetLine + radius) {
          const marker = num === targetLine ? '  ← target' : ''
          picked.push(`${String(num).padStart(5)}: ${l.content}${marker}`)
        }
      }
    }
    return picked
  }

  const grouped: Record<string, ReviewComment[]> = {}
  for (const c of reviewComments.value) {
    ;(grouped[c.file] ??= []).push(c)
  }

  let prompt = ''
  prompt += `You are acting on Diff-tab review comments for branch "${props.instance.branch}" in worktree "${gitCwd}". `
  prompt += `Apply each comment as a real file edit, then commit on the CURRENT branch.\n\n`

  prompt += 'REVIEW COMMENTS (each line shown with its exact content so there is no ambiguity):\n\n'
  for (const [file, comments] of Object.entries(grouped)) {
    prompt += `File: ${file}\n`
    for (const c of comments) {
      const safeContent = (c.lineContent || '').replace(/`/g, "'")
      prompt += `  Line ${c.line}  (content: \`${safeContent}\`)  — "${c.comment}"\n`
    }
    prompt += '\n'
    // Add a small context window (±3 lines) around each target so Claude
    // can locate the edit without grep guesswork.
    prompt += `CONTEXT for ${file}:\n`
    for (const c of comments) {
      const lines = contextWindow(file, c.line, 3)
      if (lines.length) {
        prompt += `  --- around line ${c.line} ---\n`
        for (const l of lines) prompt += `  ${l}\n`
      }
    }
    prompt += '\n'
  }

  prompt += 'REQUIRED ACTIONS:\n'
  prompt += `1. Use the Edit tool to apply every review comment exactly. Do not guess on ambiguous comments — skip them and note why.\n`
  prompt += `2. After all edits: run \`git -C "${gitCwd}" add -A && git -C "${gitCwd}" commit -m "review: apply review comments on ${props.instance.branch}"\`.\n`
  prompt += `3. End your reply with exactly one line in this format:\n`
  prompt += `     Applied: <N> file(s), committed as <short-sha>\n`
  prompt += `   OR\n`
  prompt += `     No changes made — <reason>\n`

  const url = `/api/skill/resolve/ask?issueId=${encodeURIComponent(props.instance.issueId)}&message=${encodeURIComponent(prompt)}`
  reviewStream.start(url)

  // Wait for stream to finish, then surface committed/not-committed
  // from the SSE 'done' payload and refresh the diff only if Claude
  // actually committed.
  const checkDone = setInterval(() => {
    if (!reviewStream.running.value) {
      clearInterval(checkDone)
      reviewSubmitting.value = false
      reviewComments.value = []

      const result = reviewStream.result.value as any
      const committed = !!(result && result.committed)
      reviewCommittedSha.value = result?.headAfter ? String(result.headAfter).slice(0, 7) : ''

      if (committed) {
        reviewBanner.value = { kind: 'ok', text: `Applied review — ${reviewCommittedSha.value}` }
        setTimeout(() => loadDiff(), 800)
      } else {
        reviewBanner.value = {
          kind: 'warn',
          text: `Claude finished but no commit landed on "${props.instance.branch}". ` +
                `Check the transcript above and retry, or run \`git -C "${gitCwd}" add -A && git commit\` manually.`,
        }
      }
      // Clear the banner after 30s so it doesn't linger forever
      setTimeout(() => { reviewBanner.value = null }, 30_000)
    }
  }, 500)
}

function classForDiffLine(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-gray-500'
  if (line.startsWith('+')) return 'bg-emerald-900/30 text-emerald-300'
  if (line.startsWith('-')) return 'bg-red-900/30 text-red-300'
  if (line.startsWith('@@')) return 'text-blue-400 bg-blue-900/20'
  if (line.startsWith('diff --git')) return 'text-white font-bold mt-4 pt-2 border-t border-border'
  return 'text-gray-400'
}

// Start log streaming immediately
function startLogs() {
  logStream.start(buildStreamUrl('logs', { issueId: props.instance.issueId }))
}
startLogs()

function runCommand() {
  if (!cmdInput.value.trim() || execStream.running.value) return
  const cmd = cmdInput.value.trim()
  cmdInput.value = ''
  cmdHistory.value.push({ command: cmd, lines: [], exitCode: null })
  execStream.start(buildStreamUrl('exec', { issueId: props.instance.issueId, command: cmd }))
  scrollTerminal()
}

// Watch streaming lines → append to current history entry
watch(() => execStream.lines.value.length, () => {
  const entry = cmdHistory.value[cmdHistory.value.length - 1]
  if (entry) {
    entry.lines = [...execStream.lines.value]
    scrollTerminal()
  }
})

// Watch for command completion
watch(() => execStream.result.value, (r) => {
  if (!r) return
  const entry = cmdHistory.value[cmdHistory.value.length - 1]
  if (entry) entry.exitCode = r.exitCode
  scrollTerminal()
})

function stopCommand() {
  execStream.stop()
  // Kill the process inside the container (docker exec doesn't clean up on disconnect)
  killExec(props.instance.issueId).catch(() => {})
  const entry = cmdHistory.value[cmdHistory.value.length - 1]
  if (entry && entry.exitCode === null) entry.exitCode = 130
}

function onTerminalKeydown(e: KeyboardEvent) {
  if (e.key === 'c' && e.ctrlKey && execStream.running.value) {
    e.preventDefault()
    stopCommand()
  }
}

function scrollTerminal() {
  requestAnimationFrame(() => {
    if (terminalEl.value) terminalEl.value.scrollTop = terminalEl.value.scrollHeight
  })
}

// Worktree terminal
function runWtCommand() {
  if (!wtCmdInput.value.trim() || wtStream.running.value) return
  const cmd = wtCmdInput.value.trim()
  wtCmdInput.value = ''
  wtCmdHistory.value.push({ command: cmd, lines: [], exitCode: null })
  wtStream.start(buildStreamUrl('worktree-exec', { issueId: props.instance.issueId, command: cmd }))
  scrollWtTerminal()
}

watch(() => wtStream.lines.value.length, () => {
  const entry = wtCmdHistory.value[wtCmdHistory.value.length - 1]
  if (entry) {
    entry.lines = [...wtStream.lines.value]
    scrollWtTerminal()
  }
})

watch(() => wtStream.result.value, (r) => {
  if (!r) return
  const entry = wtCmdHistory.value[wtCmdHistory.value.length - 1]
  if (entry) entry.exitCode = r.exitCode
  scrollWtTerminal()
})

function stopWtCommand() {
  wtStream.stop()
  killWorktreeExec(props.instance.issueId).catch(() => {})
  const entry = wtCmdHistory.value[wtCmdHistory.value.length - 1]
  if (entry && entry.exitCode === null) entry.exitCode = 130
}

function onWtKeydown(e: KeyboardEvent) {
  if (e.key === 'c' && e.ctrlKey && wtStream.running.value) {
    e.preventDefault()
    stopWtCommand()
  }
}

function scrollWtTerminal() {
  requestAnimationFrame(() => {
    if (wtTerminalEl.value) wtTerminalEl.value.scrollTop = wtTerminalEl.value.scrollHeight
  })
}

async function handleStop() {
  await stopInstance(props.instance.issueId)
  emit('refresh')
}

async function handleStart() {
  await startInstance(props.instance.issueId)
  emit('refresh')
}

async function handleRestart() {
  await restartInstance(props.instance.issueId)
  emit('refresh')
}

function handleRefresh() {
  if (isRefreshing.value) return
  isRefreshing.value = true
  activeTab.value = 'logs'
  logStream.stop()
  logStream.start(buildStreamUrl('refresh', { issueId: props.instance.issueId }))
}

// Handles the "Container missing" banner's Rebuild button.
// Flow mirrors Dashboard.vue:handleSetup — flip STATUS=creating so the
// subsequent refresh triggers full provisioning (docker compose up,
// DB clone verification, frontend build if needed).
const isProvisioning = ref(false)
async function handleProvision() {
  if (isProvisioning.value) return
  isProvisioning.value = true
  try {
    const res = await setupInstance(props.instance.issueId)
    if (!res.ok) {
      // Surface failure via the logs pane so the user sees why.
      activeTab.value = 'logs'
      logStream.stop()
      // Best-effort: append a synthetic error line; users usually also
      // see the actionable message in a toast from handleStop/handleStart
      // patterns elsewhere, so keep it simple.
      console.error('[provision] setupInstance failed:', res.error)
      isProvisioning.value = false
      return
    }
    activeTab.value = 'logs'
    logStream.stop()
    logStream.start(buildStreamUrl('refresh', { issueId: props.instance.issueId }))
    // Clear the provisioning flag when the stream ends so the button
    // text reverts. useStream exposes `running` which tracks that.
  } finally {
    // Don't unset here — the running stream will keep the button in
    // "Rebuilding…" state; we clear it via a watcher below.
  }
}
// Track when the refresh stream finishes so the banner's button can
// recover from "Rebuilding…" to "Rebuild container".
watch(() => logStream.running.value, (running) => {
  if (!running) isProvisioning.value = false
})

function handleCheckout() {
  if (isCheckingOut.value) return
  isCheckingOut.value = true
  activeTab.value = 'logs'
  logStream.stop()
  if (props.instance.checkedOut) {
    logStream.start(buildStreamUrl('checkout-return', {}))
  } else {
    logStream.start(buildStreamUrl('checkout', { issueId: props.instance.issueId }))
  }
}

// Watch logStream completion to reset state and reload instance data
watch(() => logStream.result.value, (r) => {
  if (r && isRefreshing.value) {
    isRefreshing.value = false
    emit('refresh')
  }
  if (r && isCheckingOut.value) {
    isCheckingOut.value = false
    emit('refresh')
  }
})

function close() {
  logStream.stop()
  if (execStream.running.value) {
    execStream.stop()
    killExec(props.instance.issueId).catch(() => {})
  }
  if (wtStream.running.value) {
    wtStream.stop()
    killWorktreeExec(props.instance.issueId).catch(() => {})
  }
  emit('close')
}

onUnmounted(() => {
  logStream.stop()
  if (execStream.running.value) {
    execStream.stop()
    killExec(props.instance.issueId).catch(() => {})
  }
  if (wtStream.running.value) {
    wtStream.stop()
    killWorktreeExec(props.instance.issueId).catch(() => {})
  }
})

function formatDate(iso: string) {
  if (!iso) return '--'
  return new Date(iso).toLocaleString()
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 bg-black/60 z-40" @click="close"></div>
    <div class="fixed inset-0 bg-surface-dark z-50 flex flex-col">
    <!-- Header -->
    <div class="flex items-center justify-between px-6 py-4 border-b border-border bg-surface">
      <div class="flex items-center gap-4">
        <button class="text-gray-400 hover:text-white transition-colors text-lg" @click="close" title="Back to list">&larr;</button>
        <div>
          <h2 class="text-lg font-bold text-white">{{ instance.issue || instance.issueId }}</h2>
          <p class="text-xs text-gray-400 mt-0.5">
            {{ instance.branch || 'no branch' }} &middot; {{ instance.mode }} &middot;
            <span :class="{
              'text-emerald-400': instance.containerStatus === 'running',
              'text-yellow-400': instance.containerStatus === 'exited',
              'text-gray-500': instance.containerStatus === 'missing',
            }">{{ instance.containerStatus }}</span>
          </p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <!-- Hide Open links when the container is missing — both would
             serve a 404 and mislead the user into thinking the app is
             broken rather than just not running. -->
        <a
          v-if="instance.appUrl && instance.containerStatus !== 'missing'"
          :href="instance.appUrl"
          target="_blank"
          class="px-3 py-1 text-xs bg-surface-dark text-blue-400 border border-border rounded hover:bg-surface-hover transition-colors"
        >Open Store</a>
        <a
          v-if="instance.appUrl && instance.containerStatus !== 'missing'"
          :href="instance.appUrl + '/admin'"
          target="_blank"
          class="px-3 py-1 text-xs bg-surface-dark text-blue-400 border border-border rounded hover:bg-surface-hover transition-colors"
        >Open Admin</a>
        <button
          v-if="instance.containerStatus === 'running'"
          class="px-3 py-1 text-xs bg-yellow-600/20 text-yellow-400 border border-yellow-600/30 rounded hover:bg-yellow-600/30 transition-colors"
          @click="handleStop"
        >Stop</button>
        <button
          v-if="instance.containerStatus === 'exited'"
          class="px-3 py-1 text-xs bg-emerald-600/20 text-emerald-400 border border-emerald-600/30 rounded hover:bg-emerald-600/30 transition-colors"
          @click="handleStart"
        >Start</button>
        <button
          v-if="instance.containerStatus === 'running'"
          class="px-3 py-1 text-xs bg-blue-600/20 text-blue-400 border border-blue-600/30 rounded hover:bg-blue-600/30 transition-colors"
          @click="handleRestart"
        >Restart</button>
        <button
          v-if="instance.containerStatus === 'running' && instance.status === 'complete'"
          class="px-3 py-1 text-xs bg-purple-600/20 text-purple-400 border border-purple-600/30 rounded hover:bg-purple-600/30 transition-colors disabled:opacity-50"
          :disabled="isRefreshing"
          @click="handleRefresh"
        >{{ isRefreshing ? 'Refreshing...' : 'Refresh' }}</button>
        <button
          v-if="instance.status === 'complete'"
          class="px-3 py-1 text-xs border rounded transition-colors disabled:opacity-50"
          :class="instance.checkedOut
            ? 'bg-orange-600/20 text-orange-400 border-orange-600/30 hover:bg-orange-600/30'
            : 'bg-cyan-600/20 text-cyan-400 border-cyan-600/30 hover:bg-cyan-600/30'"
          :disabled="isCheckingOut"
          @click="handleCheckout"
        >{{ isCheckingOut ? 'Switching...' : instance.checkedOut ? 'Return Branch' : 'Checkout' }}</button>
      </div>
    </div>

    <!-- Container-missing banner: metadata says STATUS=complete but
         docker has no container for COMPOSE_PROJECT.  Offer a one-click
         rebuild via the existing setup+refresh flow. -->
    <div
      v-if="instance.containerStatus === 'missing'"
      class="mx-6 mt-4 p-3 border border-yellow-500/40 bg-yellow-500/10 rounded-lg flex items-start gap-3"
    >
      <span class="text-yellow-400 text-lg leading-none mt-0.5">&#x26A0;</span>
      <div class="flex-1">
        <p class="text-sm text-white font-medium">Container missing</p>
        <p class="text-xs text-gray-300 mt-0.5">
          This worktree's metadata says it was fully set up, but the docker compose project
          <code class="text-blue-400">{{ instance.composeProject }}</code>
          is gone. Rebuild it to restore
          <code class="text-blue-400">{{ instance.appUrl }}</code>.
        </p>
      </div>
      <button
        class="px-3 py-1 text-xs bg-yellow-600/20 text-yellow-400 border border-yellow-600/30 rounded hover:bg-yellow-600/30 transition-colors disabled:opacity-50 whitespace-nowrap"
        :disabled="isProvisioning"
        @click="handleProvision"
      >{{ isProvisioning ? 'Rebuilding…' : 'Rebuild container' }}</button>
    </div>

    <!-- Tabs -->
    <div class="flex border-b border-border bg-surface">
      <button
        v-for="t in availableTabs"
        :key="t.id"
        class="px-4 py-2 text-sm transition-colors"
        :class="activeTab === t.id
          ? 'text-white border-b-2 border-blue-500'
          : 'text-gray-500 hover:text-gray-300'"
        @click="activeTab = t.id; t.id === 'logs' && !logStream.running.value && startLogs(); t.id === 'diff' && loadDiff()"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- Tab content -->
    <div class="flex-1 overflow-hidden flex flex-col">
      <!-- Logs tab -->
      <div v-if="activeTab === 'logs'" class="flex-1 overflow-y-auto p-4 font-mono text-xs leading-5">
        <div v-for="(line, i) in logStream.lines.value" :key="i" class="text-gray-300 whitespace-pre-wrap break-all">{{ line.line }}</div>
        <div v-if="logStream.running.value && !logStream.lines.value.length" class="text-gray-600">Connecting to logs...</div>
        <div v-if="!logStream.running.value && logStream.result.value" class="mt-2 text-gray-500 text-xs">
          Log stream ended (exit {{ logStream.result.value.exitCode }})
        </div>
      </div>

      <!-- Exec tab (streaming terminal) -->
      <div v-if="activeTab === 'exec'" ref="terminalEl"
        class="flex-1 overflow-y-auto bg-black p-4 font-mono text-xs leading-5"
        @keydown="onTerminalKeydown" tabindex="0">
        <div class="text-gray-500 mb-2">Container shell — Ctrl+C to stop running command</div>
        <template v-for="(entry, i) in cmdHistory" :key="i">
          <div class="flex">
            <span class="text-emerald-400 select-none mr-2">$</span>
            <span class="text-white">{{ entry.command }}</span>
          </div>
          <div v-for="(l, j) in entry.lines" :key="j" class="text-gray-300 whitespace-pre-wrap break-all">{{ l.line }}</div>
          <div v-if="entry.exitCode !== null" class="text-gray-600 text-xs mb-2">exit {{ entry.exitCode }}</div>
        </template>
        <div v-if="execStream.running.value" class="text-yellow-400 animate-pulse mb-1">Running... (Ctrl+C to stop)</div>
        <form v-if="!execStream.running.value" @submit.prevent="runCommand" class="flex">
          <span class="text-emerald-400 select-none mr-2">$</span>
          <input v-model="cmdInput"
            class="flex-1 bg-transparent text-white outline-none caret-emerald-400"
            autofocus spellcheck="false" autocomplete="off" />
        </form>
      </div>

      <!-- Worktree tab (runs commands directly in worktree directory) -->
      <div v-if="activeTab === 'worktree'" ref="wtTerminalEl"
        class="flex-1 overflow-y-auto bg-black p-4 font-mono text-xs leading-5"
        @keydown="onWtKeydown" tabindex="0">
        <div class="text-gray-500 mb-1">Worktree shell — runs in <span class="text-gray-400">{{ instance.worktreePath }}</span></div>
        <div class="text-gray-500 mb-2">Ctrl+C to stop running command</div>
        <template v-for="(entry, i) in wtCmdHistory" :key="i">
          <div class="flex">
            <span class="text-blue-400 select-none mr-2">$</span>
            <span class="text-white">{{ entry.command }}</span>
          </div>
          <div v-for="(l, j) in entry.lines" :key="j" class="text-gray-300 whitespace-pre-wrap break-all">{{ l.line }}</div>
          <div v-if="entry.exitCode !== null" class="text-gray-600 text-xs mb-2">exit {{ entry.exitCode }}</div>
        </template>
        <div v-if="wtStream.running.value" class="text-yellow-400 animate-pulse mb-1">Running... (Ctrl+C to stop)</div>
        <form v-if="!wtStream.running.value" @submit.prevent="runWtCommand" class="flex">
          <span class="text-blue-400 select-none mr-2">$</span>
          <input v-model="wtCmdInput"
            class="flex-1 bg-transparent text-white outline-none caret-blue-400"
            placeholder="git status, git commit -m '...', git push..."
            autofocus spellcheck="false" autocomplete="off" />
        </form>
      </div>

      <!-- Diff tab (GitHub-style review) -->
      <div v-if="activeTab === 'diff'" class="flex-1 overflow-y-auto font-mono text-xs leading-5">
        <div v-if="diffLoading" class="p-4 text-gray-500">Loading diff...</div>
        <div v-else-if="diffLoaded && parsedFiles.length === 0" class="p-4 text-gray-500">
          <div>
            No commits on <code class="text-gray-400">{{ instance.branch }}</code>
            vs <code class="text-gray-400">{{ diffBaseRef || instance.baseRef }}</code>
            <span v-if="instance.projectType === 'plugin-external' && instance.pluginName">
              in plugin <code class="text-gray-400">{{ instance.pluginName }}</code>
            </span>.
          </div>
          <div class="mt-2 text-xs">
            The diff tab shows committed changes only. If you ran <code class="text-gray-400">Resolve</code> and expected a diff,
            check the {{ instance.projectType === 'plugin-external' ? 'plugin' : 'worktree' }} log:
            <code class="text-gray-400">git -C {{ diffCwd || instance.worktreePath }} log --oneline {{ diffBaseRef || instance.baseRef }}..HEAD</code>.
            Claude may have reported no fix was needed, or may have made edits but not committed them.
          </div>
        </div>
        <template v-else-if="diffLoaded">
          <!-- Toolbar -->
          <div class="px-4 py-2 border-b border-border bg-surface flex items-center justify-between sticky top-0 z-10">
            <div class="text-gray-400 text-xs">
              {{ parsedFiles.length }} file{{ parsedFiles.length !== 1 ? 's' : '' }} changed
              <span v-if="diffStat" class="ml-2 text-gray-600">({{ diffStat.split('\n').pop()?.trim() }})</span>
            </div>
            <!-- Post-review result banner: shows whether Claude's run
                 actually committed a change.  Replaces the silent
                 "no diff appeared" UX. -->
            <div
              v-if="reviewBanner"
              class="mx-4 my-2 px-3 py-2 rounded text-xs border"
              :class="{
                'bg-emerald-600/10 border-emerald-600/40 text-emerald-300': reviewBanner.kind === 'ok',
                'bg-yellow-600/10 border-yellow-600/40 text-yellow-300':    reviewBanner.kind === 'warn',
                'bg-red-600/10 border-red-600/40 text-red-300':             reviewBanner.kind === 'err',
              }"
            >{{ reviewBanner.text }}</div>
            <div class="flex items-center gap-2">
              <button
                v-if="reviewComments.length > 0 && features.resolveEnabled"
                class="px-3 py-1 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-500 transition-colors"
                :disabled="reviewSubmitting"
                @click="submitReview"
              >
                {{ reviewSubmitting ? 'Submitting...' : `Submit Review (${reviewComments.length})` }}
              </button>
              <button
                class="px-2 py-1 text-xs text-gray-500 hover:text-gray-300 border border-border rounded transition-colors"
                @click="loadDiff"
              >Refresh</button>
            </div>
          </div>

          <!-- File-by-file diff -->
          <div v-for="file in parsedFiles" :key="file.path" class="border-b border-border">
            <!-- File header -->
            <div
              class="px-4 py-2 bg-surface-dark flex items-center gap-2 cursor-pointer hover:bg-surface sticky top-[33px] z-[5] border-b border-border"
              @click="file.collapsed = !file.collapsed"
            >
              <span class="text-gray-500 text-[10px]">{{ file.collapsed ? '▶' : '▼' }}</span>
              <span class="text-white font-semibold text-xs">{{ file.path }}</span>
              <span class="text-emerald-400 text-[10px]">+{{ file.additions }}</span>
              <span class="text-red-400 text-[10px]">-{{ file.deletions }}</span>
            </div>

            <!-- Hunks -->
            <div v-if="!file.collapsed">
              <template v-for="hunk in file.hunks" :key="hunk.header">
                <template v-for="(line, li) in hunk.lines" :key="li">
                  <!-- Hunk header -->
                  <div v-if="line.type === 'hunk-header'" class="flex bg-blue-900/10 text-blue-400 border-b border-border/30">
                    <div class="w-[100px] flex-shrink-0" />
                    <div class="flex-1 px-2 py-0.5">{{ line.content }}</div>
                  </div>

                  <!-- Code line -->
                  <div
                    v-else
                    class="flex group"
                    :class="{
                      'bg-emerald-900/20': line.type === 'add',
                      'bg-red-900/20': line.type === 'del',
                    }"
                  >
                    <!-- Line numbers -->
                    <div class="w-[50px] flex-shrink-0 text-right pr-1 select-none border-r border-border/30"
                      :class="line.type === 'del' ? 'text-red-700' : line.type === 'add' ? 'text-emerald-700' : 'text-gray-700'"
                    >{{ line.oldLine ?? '' }}</div>
                    <div class="w-[50px] flex-shrink-0 text-right pr-1 select-none border-r border-border/30"
                      :class="line.type === 'del' ? 'text-red-700' : line.type === 'add' ? 'text-emerald-700' : 'text-gray-700'"
                    >{{ line.newLine ?? '' }}</div>

                    <!-- Content + comment button -->
                    <div class="flex-1 px-2 whitespace-pre-wrap break-all relative"
                      :class="{
                        'text-emerald-300': line.type === 'add',
                        'text-red-300': line.type === 'del',
                        'text-gray-400': line.type === 'context',
                      }"
                    >
                      <span>{{ line.content || ' ' }}</span>
                      <!-- Comment trigger (+ button on hover) -->
                      <button
                        v-if="line.newLine && line.type !== 'del'"
                        class="absolute left-[-8px] top-0 w-4 h-4 text-[10px] leading-4 text-center bg-blue-600 text-white rounded-sm opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                        @click.stop="startComment(file.path, line.newLine!, line.content)"
                        title="Add review comment"
                      >+</button>
                    </div>

                    <!-- Existing comment indicator -->
                    <div v-if="line.newLine && hasCommentAt(file.path, line.newLine)" class="w-6 flex-shrink-0 flex items-center justify-center">
                      <span class="text-[10px] text-yellow-400" title="Has comment">💬</span>
                    </div>
                  </div>

                  <!-- Inline comment form -->
                  <div
                    v-if="commentingAt && commentingAt.file === file.path && commentingAt.line === line.newLine"
                    class="bg-surface border-y border-blue-500/30 px-4 py-3"
                  >
                    <div class="text-gray-500 text-[10px] mb-1">Comment on line {{ line.newLine }}</div>
                    <textarea
                      v-model="commentInput"
                      class="w-full bg-surface-dark border border-border rounded px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y"
                      rows="2"
                      placeholder="Leave a review comment or suggestion..."
                      @keydown.meta.enter="addComment"
                      @keydown.ctrl.enter="addComment"
                    />
                    <div class="flex gap-2 mt-1">
                      <button
                        class="px-2 py-0.5 text-[10px] bg-emerald-600 text-white rounded hover:bg-emerald-500"
                        @click="addComment"
                      >Add comment</button>
                      <button
                        class="px-2 py-0.5 text-[10px] text-gray-500 hover:text-gray-300"
                        @click="cancelComment"
                      >Cancel</button>
                    </div>
                  </div>

                  <!-- Existing comment display -->
                  <div
                    v-if="line.newLine && hasCommentAt(file.path, line.newLine) && !(commentingAt && commentingAt.file === file.path && commentingAt.line === line.newLine)"
                    class="bg-yellow-900/10 border-l-2 border-yellow-500/50 px-4 py-2 ml-[100px]"
                  >
                    <div class="text-yellow-300 text-xs">{{ hasCommentAt(file.path, line.newLine)!.comment }}</div>
                    <button
                      class="text-[10px] text-gray-600 hover:text-red-400 mt-0.5"
                      @click="removeComment(reviewComments.indexOf(hasCommentAt(file.path, line.newLine)!))"
                    >Remove</button>
                  </div>
                </template>
              </template>
            </div>
          </div>

          <!-- Pending review summary -->
          <div v-if="reviewComments.length > 0 && !reviewSubmitting" class="p-4 border-t border-border bg-surface">
            <div class="text-xs text-gray-400 mb-2">{{ reviewComments.length }} pending comment{{ reviewComments.length !== 1 ? 's' : '' }}</div>
            <div v-for="(c, idx) in reviewComments" :key="idx" class="flex items-start gap-2 text-xs mb-1">
              <span class="text-gray-600 shrink-0">{{ c.file.split('/').pop() }}:{{ c.line }}</span>
              <span class="text-gray-300 flex-1">{{ c.comment }}</span>
              <button class="text-gray-600 hover:text-red-400" @click="removeComment(idx)">✕</button>
            </div>
          </div>

          <!-- Claude response stream -->
          <div v-if="reviewStream.lines.value.length > 0 || reviewStream.running.value" class="border-t border-border p-4">
            <div class="text-xs text-gray-500 mb-2">Claude's response:</div>
            <div class="bg-surface-dark rounded p-3 max-h-[300px] overflow-y-auto">
              <div
                v-for="(ev, idx) in reviewStream.lines.value"
                :key="idx"
                class="text-xs text-gray-300 whitespace-pre-wrap"
              >{{ (ev as any).line }}</div>
              <div v-if="reviewStream.running.value" class="text-xs text-yellow-400 animate-pulse mt-1">Claude is updating code...</div>
            </div>
          </div>
        </template>
      </div>

      <!-- Info tab -->
      <div v-if="activeTab === 'info'" class="flex-1 overflow-y-auto p-4">
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt class="text-gray-500">Issue</dt>
          <dd class="text-white">{{ instance.issue || instance.issueId }}</dd>

          <dt class="text-gray-500">Branch</dt>
          <dd class="text-white font-mono text-xs">{{ instance.branch || '--' }}</dd>

          <dt class="text-gray-500">Base Ref</dt>
          <dd class="text-white font-mono text-xs">{{ instance.baseRef || '--' }}</dd>

          <dt class="text-gray-500">Mode</dt>
          <dd class="text-white">{{ instance.mode }}</dd>

          <dt class="text-gray-500">Project</dt>
          <dd class="text-white">{{ instance.project }} ({{ instance.projectType }})</dd>

          <dt class="text-gray-500">Domain</dt>
          <dd>
            <a v-if="instance.appUrl" :href="instance.appUrl" target="_blank" class="text-blue-400 hover:text-blue-300 underline underline-offset-2">
              {{ instance.domain || instance.appUrl }}
            </a>
            <span v-else class="text-gray-600">--</span>
          </dd>

          <dt class="text-gray-500">Admin</dt>
          <dd>
            <a v-if="instance.appUrl" :href="instance.appUrl + '/admin'" target="_blank" class="text-blue-400 hover:text-blue-300 underline underline-offset-2">
              {{ (instance.domain || instance.appUrl) + '/admin' }}
            </a>
          </dd>

          <dt class="text-gray-500">Database</dt>
          <dd class="text-white font-mono text-xs">{{ instance.dbName }} ({{ instance.dbState || 'unknown' }})</dd>

          <dt class="text-gray-500">Compose Project</dt>
          <dd class="text-white font-mono text-xs">{{ instance.composeProject }}</dd>

          <dt class="text-gray-500">Worktree Path</dt>
          <dd class="text-white font-mono text-xs">{{ instance.worktreePath }}</dd>

          <dt class="text-gray-500">Container</dt>
          <dd class="text-white">{{ instance.containerStatus }} {{ instance.containerInfo ? `(${instance.containerInfo})` : '' }}</dd>

          <dt class="text-gray-500">Created</dt>
          <dd class="text-white">{{ formatDate(instance.createdAt) }}</dd>

          <template v-if="instance.pluginName">
            <dt class="text-gray-500 pt-2 border-t border-border mt-2">Plugin</dt>
            <dd class="text-purple-400 pt-2 border-t border-border mt-2">{{ instance.pluginName }}</dd>

            <dt class="text-gray-500">Plugin path</dt>
            <dd class="text-white font-mono text-xs">
              {{ instance.worktreePath }}/custom/plugins/{{ instance.pluginName }}
            </dd>

            <dt class="text-gray-500">Plugin branch</dt>
            <dd class="text-white font-mono text-xs">{{ instance.branch }}</dd>
          </template>

          <template v-if="instance.linkedPlugins && instance.linkedPlugins.length > 1">
            <dt class="text-gray-500">Linked plugins</dt>
            <dd class="text-purple-400 text-xs">
              {{ instance.linkedPlugins.join(', ') }}
            </dd>
          </template>

          <template v-if="instance.changes">
            <dt class="text-gray-500 pt-2 border-t border-border mt-2">Changes</dt>
            <dd class="text-white pt-2 border-t border-border mt-2 text-xs space-x-3">
              <span v-if="instance.changes.admin">Admin: {{ instance.changes.admin }}</span>
              <span v-if="instance.changes.storefront">Storefront: {{ instance.changes.storefront }}</span>
              <span v-if="instance.changes.backend">Backend: {{ instance.changes.backend }}</span>
              <span v-if="instance.changes.migration">Migration: {{ instance.changes.migration }}</span>
              <span v-if="instance.changes.composer">Composer: {{ instance.changes.composer }}</span>
            </dd>
          </template>
        </dl>
      </div>

      <!-- Plugin-provided tab -->
      <div v-if="activePluginTab" class="flex-1 overflow-y-auto">
        <PluginSlot
          :render="activePluginTab.render"
          :instance="instance"
          :key="activeTab"
        />
      </div>
    </div>
  </div>
  </Teleport>
</template>
