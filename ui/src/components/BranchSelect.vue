<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { fetchBranches } from '@/api'

const props = defineProps<{ modelValue: string; project: string; plugin?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const query = ref(props.modelValue)
const branches = ref<string[]>([])
const open = ref(false)
const loading = ref(false)
const highlightIndex = ref(-1)
const wrapper = ref<HTMLElement | null>(null)
let debounceTimer: ReturnType<typeof setTimeout> | null = null

watch(() => props.modelValue, (v) => { query.value = v })
watch(() => props.project, () => { branches.value = []; query.value = ''; emit('update:modelValue', '') })
watch(() => props.plugin, () => { branches.value = []; query.value = ''; emit('update:modelValue', '') })

async function search(q?: string) {
  if (!props.project) return
  loading.value = true
  try {
    branches.value = await fetchBranches(props.project, q || undefined, props.plugin || undefined)
  } catch {
    branches.value = []
  } finally {
    loading.value = false
  }
}

function onInput(e: Event) {
  const val = (e.target as HTMLInputElement).value
  query.value = val
  emit('update:modelValue', val)
  highlightIndex.value = -1
  open.value = true
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => search(val), 300)
}

function onFocus() {
  open.value = true
  if (!branches.value.length) search(query.value || undefined)
}

function select(branch: string) {
  query.value = branch
  emit('update:modelValue', branch)
  open.value = false
}

function onKeydown(e: KeyboardEvent) {
  if (!open.value || !branches.value.length) return

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    highlightIndex.value = Math.min(highlightIndex.value + 1, branches.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    highlightIndex.value = Math.max(highlightIndex.value - 1, 0)
  } else if (e.key === 'Enter' && highlightIndex.value >= 0) {
    e.preventDefault()
    select(branches.value[highlightIndex.value])
  } else if (e.key === 'Escape') {
    open.value = false
  }
}

function handleClickOutside(e: MouseEvent) {
  if (wrapper.value && !wrapper.value.contains(e.target as Node)) {
    open.value = false
  }
}

onMounted(() => document.addEventListener('mousedown', handleClickOutside))
onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside)
  if (debounceTimer) clearTimeout(debounceTimer)
})
</script>

<template>
  <div ref="wrapper" class="relative">
    <input
      :value="query"
      @input="onInput"
      @focus="onFocus"
      @keydown="onKeydown"
      :disabled="!project"
      class="w-full bg-surface-dark border border-border rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-40"
      :placeholder="project ? 'Search branches…' : 'Select a project first'"
    />
    <span v-if="loading" class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-xs">...</span>

    <div
      v-if="open && branches.length > 0"
      class="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto bg-surface-dark border border-border rounded shadow-xl"
    >
      <button
        v-for="(branch, i) in branches"
        :key="branch"
        type="button"
        class="w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-surface-hover transition-colors truncate"
        :class="{ 'bg-surface-hover text-white': i === highlightIndex }"
        @mousedown.prevent="select(branch)"
      >
        {{ branch }}
      </button>
    </div>
    <div
      v-if="open && !loading && branches.length === 0 && query && project"
      class="absolute z-50 mt-1 w-full bg-surface-dark border border-border rounded shadow-xl px-3 py-2 text-xs text-gray-500"
    >
      No matching branches
    </div>
  </div>
</template>
