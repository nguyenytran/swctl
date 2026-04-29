<script setup lang="ts">
/**
 * Persistent "active operations" indicator pinned to the top header,
 * visible on every route.  Surfaces in-flight creates/cleans/refreshes
 * so the user can navigate between Dashboard/Worktrees/Resolve without
 * losing visibility into long-running work.
 *
 * Renders nothing when no operations are active.  When 1+ are running,
 * shows a compact pill per operation:
 *
 *   [ ⚙ create #1234  Step 3/5: Sync · 18s ]
 *   [ 🧹 clean #5678  · 4s ]
 *
 * Each pill auto-removes when its stream-done event arrives (handled
 * inside useActiveOperations).
 */
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useActiveOperations, type ActiveOperation } from '@/composables/useActiveOperations'

const { operations } = useActiveOperations()

// Tick a `now` ref every second so elapsed-time labels stay live.
// The composable doesn't need to do this — only the UI cares about
// real-time elapsed display.
const now = ref(Date.now())
let timer: number | null = null
onMounted(() => {
  timer = window.setInterval(() => { now.value = Date.now() }, 1000)
})
onUnmounted(() => {
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
})

const sortedOperations = computed<ActiveOperation[]>(() => {
  // Stable: most recently started first (the user most likely cares
  // about whichever they just kicked off).
  return [...operations.value].sort((a, b) => b.startedAt - a.startedAt)
})

function elapsed(startedAt: number): string {
  const s = Math.max(0, Math.round((now.value - startedAt) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60), rs = s % 60
  return rs ? `${m}m ${rs}s` : `${m}m`
}

function kindIcon(kind: string): string {
  switch (kind) {
    case 'create':   return '⚙'
    case 'clean':    return '🧹'
    case 'refresh':  return '↻'
    case 'switch':   return '⇄'
    case 'checkout': return '⊕'
    default:         return '·'
  }
}

function kindLabel(kind: string): string {
  // 'create' → 'Creating', 'clean' → 'Cleaning'.  Capitalise +
  // -ing-form so the pill reads naturally.
  if (!kind) return ''
  // Drop trailing 'e' before -ing: create→creating, refresh→refreshing,
  // switch→switching, clean→cleaning.
  const base = kind.toLowerCase()
  if (base.endsWith('e')) return base.slice(0, -1) + 'ing'
  return base + 'ing'
}
</script>

<template>
  <!-- Fixed-height row reserves space so the header doesn't reflow as
       operations come and go.  Renders empty when no ops are active —
       css visibility: hidden keeps the layout slot. -->
  <div
    class="flex items-center gap-2"
    :style="{ visibility: sortedOperations.length === 0 ? 'hidden' : 'visible' }"
  >
    <transition-group name="op-pill" tag="div" class="flex items-center gap-2">
      <div
        v-for="op in sortedOperations"
        :key="op.streamId"
        class="inline-flex items-center gap-2 px-3 py-1 text-xs rounded-full border bg-surface-dark border-border"
        :class="{
          'border-blue-500/50': op.kind === 'create',
          'border-amber-500/50': op.kind === 'clean',
          'border-emerald-500/50': op.kind === 'refresh',
        }"
        :title="`Stream: ${op.streamId}`"
      >
        <span class="text-sm leading-none">{{ kindIcon(op.kind) }}</span>
        <span class="text-gray-300 capitalize">{{ kindLabel(op.kind) }}</span>
        <span v-if="op.issueId" class="text-blue-400 font-mono">#{{ op.issueId }}</span>
        <!-- Step progress (only if total > 0 — i.e., create's 5 steps).
             Other ops just show elapsed. -->
        <span v-if="op.total > 0 && op.step > 0" class="text-gray-500">
          ·
          <span class="text-gray-300">Step {{ op.step }}/{{ op.total }}</span>
          <span v-if="op.stepName" class="text-gray-500">: {{ op.stepName }}</span>
        </span>
        <span class="text-gray-500">·</span>
        <span class="text-gray-400 font-mono tabular-nums">{{ elapsed(op.startedAt) }}</span>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.op-pill-enter-active,
.op-pill-leave-active {
  transition: opacity 0.25s, transform 0.25s;
}
.op-pill-enter-from,
.op-pill-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
