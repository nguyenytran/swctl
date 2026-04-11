<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import type { StreamEvent, StreamDone } from '@/types'

const props = defineProps<{
  lines: StreamEvent[]
  running: boolean
  result: StreamDone | null
}>()

const emit = defineEmits<{ close: [] }>()
const logContainer = ref<HTMLElement | null>(null)

watch(
  () => props.lines.length,
  async () => {
    await nextTick()
    if (logContainer.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight
    }
  },
)

function formatElapsed(ms: number) {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}
</script>

<template>
  <div class="mb-6 border border-border rounded-lg overflow-hidden bg-surface-dark">
    <div class="flex items-center justify-between px-4 py-2 bg-surface border-b border-border">
      <div class="flex items-center gap-2">
        <span v-if="running" class="w-2 h-2 rounded-full bg-blue-400 animate-pulse"></span>
        <span v-else-if="result?.exitCode === 0" class="w-2 h-2 rounded-full bg-emerald-400"></span>
        <span v-else class="w-2 h-2 rounded-full bg-red-400"></span>
        <span class="text-xs text-gray-400">
          <template v-if="running">Running…</template>
          <template v-else-if="result">
            {{ result.exitCode === 0 ? 'Completed' : `Failed (exit ${result.exitCode})` }}
            in {{ formatElapsed(result.elapsed) }}
          </template>
        </span>
      </div>
      <button
        v-if="!running"
        class="text-xs text-gray-500 hover:text-white transition-colors"
        @click="emit('close')"
      >
        Close
      </button>
    </div>
    <div ref="logContainer" class="p-4 max-h-80 overflow-y-auto font-mono text-xs leading-5">
      <div v-for="(line, i) in lines" :key="i" class="text-gray-300 whitespace-pre-wrap break-all">{{ line.line }}</div>
      <div v-if="running && !lines.length" class="text-gray-600">Waiting for output…</div>
    </div>
  </div>
</template>
