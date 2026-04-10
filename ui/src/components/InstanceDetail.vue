<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import type { Instance, StreamEvent } from '@/types'
import { useStream } from '@/composables/useStream'
import { stopInstance, startInstance, restartInstance, buildStreamUrl, killExec, killWorktreeExec } from '@/api'

const props = defineProps<{ instance: Instance }>()
const emit = defineEmits<{ close: []; refresh: [] }>()

const activeTab = ref<'logs' | 'exec' | 'worktree' | 'info'>('logs')
const logStream = useStream()
const execStream = useStream()
const wtStream = useStream()
const cmdInput = ref('')
const cmdHistory = ref<Array<{ command: string; lines: StreamEvent[]; exitCode: number | null }>>([])
const terminalEl = ref<HTMLElement | null>(null)
const wtCmdInput = ref('')
const wtCmdHistory = ref<Array<{ command: string; lines: StreamEvent[]; exitCode: number | null }>>([])
const wtTerminalEl = ref<HTMLElement | null>(null)


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
        <a
          v-if="instance.appUrl"
          :href="instance.appUrl"
          target="_blank"
          class="px-3 py-1 text-xs bg-surface-dark text-blue-400 border border-border rounded hover:bg-surface-hover transition-colors"
        >Open Store</a>
        <a
          v-if="instance.appUrl"
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
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex border-b border-border bg-surface">
      <button
        v-for="tab in (['logs', 'exec', ...(instance.worktreePath ? ['worktree'] : []), 'info'] as const)"
        :key="tab"
        class="px-4 py-2 text-sm transition-colors"
        :class="activeTab === tab
          ? 'text-white border-b-2 border-blue-500'
          : 'text-gray-500 hover:text-gray-300'"
        @click="activeTab = tab as typeof activeTab; tab === 'logs' && !logStream.running.value && startLogs()"
      >
        {{ tab === 'logs' ? 'Logs' : tab === 'exec' ? 'Console' : tab === 'worktree' ? 'Worktree' : 'Info' }}
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
            <dt class="text-gray-500">Plugin</dt>
            <dd class="text-purple-400">{{ instance.pluginName }}</dd>
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
    </div>
  </div>
  </Teleport>
</template>
