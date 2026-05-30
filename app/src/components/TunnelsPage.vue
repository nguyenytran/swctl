<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { getTunnels, stopTunnel, stopNamedPreview, type Tunnel } from '@/api'

/**
 * /#/tunnels — fleet-wide Cloudflare tunnel management.
 *
 * Shows every preview tunnel across all instances (swctl "quick" tunnels +
 * hand-rolled "named" tunnels), backed by `swctl preview list --json` so the
 * table never drifts from the CLI. Each row can be stopped/removed; quick
 * tunnels stop via the CLI (metadata stays consistent), named tunnels are
 * removed by container. Auto-refreshes every 10s while the page is open.
 */

const tunnels = ref<Tunnel[]>([])
const loading = ref(true)
const error = ref('')
const busy = ref<Record<string, boolean>>({})
const message = ref('')
let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  error.value = ''
  try {
    const r = await getTunnels()
    tunnels.value = r.tunnels || []
    if (!r.ok && tunnels.value.length === 0) error.value = 'Could not read tunnels (is Docker running?)'
  } catch (e: any) {
    error.value = e?.message || 'Failed to load tunnels.'
  } finally {
    loading.value = false
  }
}

async function stop(t: Tunnel) {
  if (!confirm(`Stop tunnel "${t.container}"${t.issue ? ` (issue ${t.issue})` : ''}?`)) return
  busy.value = { ...busy.value, [t.container]: true }
  message.value = ''
  try {
    // Named previews share one container per project — stop them per-issue so
    // sibling instances on the same shared tunnel keep running.
    const r = (t.type === 'named' && t.container.startsWith('swctl-tunnel-') && t.issue)
      ? await stopNamedPreview(t.issue)
      : await stopTunnel(t.container)
    message.value = r.ok ? `Stopped ${t.issue ? 'sw-' + t.issue : t.container}.` : `Failed: ${(r as any).error || (r as any).output || 'unknown error'}`
    await load()
  } catch (e: any) {
    message.value = `Failed: ${e?.message || String(e)}`
  } finally {
    busy.value = { ...busy.value, [t.container]: false }
  }
}

async function copy(url: string) {
  try { await navigator.clipboard.writeText(url); message.value = 'URL copied.' }
  catch { message.value = 'Clipboard unavailable — copy manually.' }
}

onMounted(() => { load(); timer = setInterval(load, 10_000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="p-6 max-w-5xl mx-auto">
    <div class="flex items-center justify-between mb-4">
      <div>
        <h1 class="text-lg text-white font-medium">Tunnels</h1>
        <p class="text-sm text-gray-500">Cloudflare preview tunnels across all instances.</p>
      </div>
      <button
        class="px-3 py-1 text-sm rounded bg-surface text-gray-300 hover:text-white transition-colors"
        :disabled="loading"
        @click="load"
      >{{ loading ? 'Refreshing…' : 'Refresh' }}</button>
    </div>

    <p v-if="message" class="text-sm text-gray-400 mb-3">{{ message }}</p>
    <p v-if="error" class="text-sm text-red-400 mb-3">{{ error }}</p>

    <div v-if="loading && tunnels.length === 0" class="text-sm text-gray-500">Loading…</div>

    <div v-else-if="tunnels.length === 0" class="text-sm text-gray-500">
      No tunnels running. Start one from an instance's Ops tab or <code>swctl preview &lt;issue&gt;</code>.
    </div>

    <table v-else class="w-full text-sm">
      <thead>
        <tr class="text-left text-gray-500 border-b border-white/10">
          <th class="py-2 pr-3 font-medium">Issue</th>
          <th class="py-2 pr-3 font-medium">Type</th>
          <th class="py-2 pr-3 font-medium">Status</th>
          <th class="py-2 pr-3 font-medium">URL</th>
          <th class="py-2 pr-3 font-medium text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="t in tunnels" :key="t.container" class="border-b border-white/5">
          <td class="py-2 pr-3 text-gray-300">{{ t.issue || '—' }}</td>
          <td class="py-2 pr-3">
            <span
              class="px-1.5 py-0.5 rounded text-xs"
              :class="t.type === 'quick' ? 'bg-blue-500/15 text-blue-300' : 'bg-purple-500/15 text-purple-300'"
            >{{ t.type }}</span>
          </td>
          <td class="py-2 pr-3">
            <span :class="t.status === 'running' ? 'text-green-400' : 'text-gray-500'">{{ t.status }}</span>
          </td>
          <td class="py-2 pr-3 max-w-[280px] truncate">
            <a v-if="t.url" :href="t.url" target="_blank" class="text-blue-400 hover:underline">{{ t.url }}</a>
            <span v-else class="text-gray-600">{{ t.type === 'named' ? '(named — see ~/.cloudflared)' : '—' }}</span>
          </td>
          <td class="py-2 pr-3 text-right whitespace-nowrap">
            <button
              v-if="t.url"
              class="px-2 py-0.5 text-xs rounded text-gray-400 hover:text-white"
              @click="copy(t.url)"
            >Copy</button>
            <button
              class="px-2 py-0.5 text-xs rounded text-red-400 hover:text-red-300 disabled:opacity-50"
              :disabled="busy[t.container]"
              @click="stop(t)"
            >{{ busy[t.container] ? 'Stopping…' : 'Stop' }}</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
