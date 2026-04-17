<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import type { PluginContext, PluginRender } from '@/types/plugin'
import { buildPluginContext } from '@/composables/usePlugins'
import type { Instance } from '@/types'

const props = defineProps<{
  render: PluginRender
  instance?: Instance
  // Identity key: when this changes, the slot is remounted (cleanup + fresh render)
  key?: string | number
}>()

const host = ref<HTMLElement | null>(null)
let cleanup: (() => void) | void

function mount() {
  if (!host.value) return
  host.value.innerHTML = ''
  const ctx: PluginContext = buildPluginContext({ instance: props.instance })
  try {
    cleanup = props.render(host.value, ctx)
  } catch (err: any) {
    console.error('[plugin render]', err)
    host.value.innerHTML = `<div style="color:#f87171;padding:8px;font:12px monospace">Plugin render failed: ${escape(err?.message || String(err))}</div>`
  }
}

function unmount() {
  if (typeof cleanup === 'function') {
    try { cleanup() } catch (err) { console.error('[plugin cleanup]', err) }
  }
  cleanup = undefined
  if (host.value) host.value.innerHTML = ''
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

onMounted(mount)
onBeforeUnmount(unmount)

// When the identity key or instance changes, remount (lets parent force refresh)
watch(
  () => [props.key, props.instance?.issueId],
  () => { unmount(); mount() },
)
</script>

<template>
  <div ref="host" class="plugin-slot"></div>
</template>
