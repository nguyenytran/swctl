<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import QRCode from 'qrcode'
import { copyToClipboard } from '@/utils/clipboard'
import {
  getTunnels, stopTunnel, stopNamedPreview, getTunnelConfig, saveTunnelConfig, reapTunnels,
  listCloudflaredTunnels, startCloudflaredLogin, cloudflaredLoginStatus, cancelCloudflaredLogin, getCloudflaredAccount, createCloudflaredTunnel,
  type Tunnel, type CloudflaredTunnel, type CloudflaredAccount,
} from '@/api'
import ConfirmDialog from './ConfirmDialog.vue'

/**
 * /#/tunnels — fleet-wide Cloudflare tunnel management.
 *
 * Lists every preview tunnel across instances (swctl "quick" + named), backed
 * by `swctl preview list --json` so the table never drifts from the CLI. Each
 * row can be stopped (with a styled confirm modal + inline loading); named
 * previews stop per-issue so siblings on the shared tunnel keep running.
 * Auto-refreshes every 10s while the page is open.
 */

const tunnels = ref<Tunnel[]>([])
const loading = ref(true)
const refreshing = ref(false)
const error = ref('')
const busy = ref<Record<string, boolean>>({})
const message = ref('')
const confirmAction = ref<{ title: string; message: string; onConfirm: () => void } | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

// Named-preview config (SW_PREVIEW_* in .swctl.conf)
const showConfig = ref(false)
const cfgDomain = ref('')
const cfgTunnelId = ref('')
const cfgSaving = ref(false)
const cfgMessage = ref('')

// Available Cloudflare tunnels (for the dropdown).
const cfTunnels = ref<CloudflaredTunnel[]>([])
const cfLoading = ref(false)
const cfError = ref('')

async function loadConfig() {
  try {
    const c = await getTunnelConfig()
    cfgDomain.value = c.domain || ''
    cfgTunnelId.value = c.tunnelId || ''
  } catch { /* ignore */ }
}

// Cloudflare login/account status
const account = ref<CloudflaredAccount>({ loggedIn: false })
const accountLoading = ref(false)

async function loadAccount() {
  accountLoading.value = true
  try { account.value = await getCloudflaredAccount() } catch { /* ignore */ } finally { accountLoading.value = false }
}

function toggleConfig() {
  showConfig.value = !showConfig.value
  if (showConfig.value) {
    if (cfTunnels.value.length === 0) loadCfTunnels()
    loadAccount()
  }
}

// Interactive Cloudflare login (browser auth from the UI).
const loginState = ref<'idle' | 'starting' | 'waiting' | 'done' | 'error'>('idle')
const loginUrl = ref('')
const loginError = ref('')
let loginTimer: ReturnType<typeof setInterval> | null = null

async function doLogin() {
  loginState.value = 'starting'
  loginError.value = ''
  loginUrl.value = ''
  try {
    const r = await startCloudflaredLogin()
    if (!r.ok || !r.url) { loginState.value = 'error'; loginError.value = r.error || 'Could not start login.'; return }
    loginUrl.value = r.url
    loginState.value = 'waiting'
    window.open(r.url, '_blank', 'noopener')
    loginTimer = setInterval(pollLogin, 2500)
  } catch (e: any) {
    loginState.value = 'error'; loginError.value = e?.message || String(e)
  }
}

async function pollLogin() {
  try {
    const s = await cloudflaredLoginStatus()
    if (s.state === 'done') {
      stopLoginPoll()
      loginState.value = 'done'
      await Promise.all([loadCfTunnels(), loadAccount()])
    } else if (s.state === 'error' || s.state === 'idle') {
      stopLoginPoll()
      loginState.value = 'error'
      loginError.value = s.error || 'Login did not complete.'
    }
  } catch { /* keep polling */ }
}

function stopLoginPoll() { if (loginTimer) { clearInterval(loginTimer); loginTimer = null } }

async function cancelLogin() {
  stopLoginPoll()
  try { await cancelCloudflaredLogin() } catch {}
  loginState.value = 'idle'
  loginUrl.value = ''
}

// Create a new tunnel (+ wildcard DNS) from the UI.
const newTunnelName = ref('swctl-preview')
const creating = ref(false)
const createMsg = ref('')

// The currently-configured tunnel, if it still exists on the account.
// When set, the "Create tunnel" action is redundant (and would create a
// duplicate / repoint DNS), so the UI guides toward reusing it instead.
const configuredTunnel = computed(() =>
  cfgTunnelId.value ? cfTunnels.value.find(t => t.id === cfgTunnelId.value) || null : null)

async function createTunnel(force = false) {
  if (!newTunnelName.value.trim()) return
  creating.value = true
  createMsg.value = ''
  try {
    const r = await createCloudflaredTunnel(newTunnelName.value.trim(), cfgDomain.value.trim(), force)
    if (r.ok && r.id) {
      // Server already persisted the config + DNS atomically; just refresh state.
      await Promise.all([loadCfTunnels(), loadConfig()])
      createMsg.value = r.dnsConfigured
        ? `Created “${r.name}”, wildcard DNS added, and selected it.`
        : `Created “${r.name}” and selected it. Set a domain + Save to add wildcard DNS.`
      return
    }
    // A tunnel is already wired — confirm before creating a duplicate (which
    // also repoints the *.<domain> wildcard away from the working tunnel).
    if (r.alreadyConfigured) {
      const ex = r.existing
      confirmAction.value = {
        title: 'A tunnel is already configured',
        message: `“${ex?.name || ex?.id}” is already set up and serving your previews. ` +
          `Creating “${newTunnelName.value.trim()}” will repoint *.${cfgDomain.value.trim() || 'your-domain'} ` +
          `to the new tunnel. Create it anyway?`,
        onConfirm: () => { confirmAction.value = null; void createTunnel(true) },
      }
      return
    }
    createMsg.value = r.rolledBack
      ? `Failed (rolled back, nothing left behind): ${r.error || 'unknown error'}`
      : `Failed: ${r.error || 'unknown error'}`
  } catch (e: any) {
    createMsg.value = `Failed: ${e?.message || String(e)}`
  } finally {
    creating.value = false
  }
}

async function loadCfTunnels() {
  cfLoading.value = true
  cfError.value = ''
  try {
    const r = await listCloudflaredTunnels()
    cfTunnels.value = r.tunnels || []
    if (!r.ok) cfError.value = r.error || 'Could not list tunnels (is cloudflared logged in?).'
  } catch (e: any) {
    cfError.value = e?.message || 'Failed to list tunnels.'
  } finally {
    cfLoading.value = false
  }
}

async function saveConfig() {
  cfgSaving.value = true
  cfgMessage.value = ''
  try {
    const r = await saveTunnelConfig({ domain: cfgDomain.value.trim(), tunnelId: cfgTunnelId.value.trim() })
    cfgMessage.value = r.ok ? 'Saved to .swctl.conf.' : `Failed: ${r.error || 'unknown error'}`
  } catch (e: any) {
    cfgMessage.value = `Failed: ${e?.message || String(e)}`
  } finally {
    cfgSaving.value = false
  }
}

async function load(isRefresh = false) {
  if (isRefresh) refreshing.value = true
  error.value = ''
  try {
    const r = await getTunnels()
    tunnels.value = r.tunnels || []
    if (!r.ok && tunnels.value.length === 0) error.value = 'Could not read tunnels (is Docker running?)'
  } catch (e: any) {
    error.value = e?.message || 'Failed to load tunnels.'
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

function requestStop(t: Tunnel) {
  const isNamed = t.type === 'named' && t.container.startsWith('swctl-tunnel-') && !!t.issue
  confirmAction.value = {
    title: 'Stop tunnel',
    message: isNamed
      ? `Stop the named preview for instance ${t.issue} (${t.url})? The instance keeps running; other instances on the shared tunnel are unaffected.`
      : `Stop tunnel "${t.container}"${t.issue ? ` (issue ${t.issue})` : ''}? This only removes the tunnel — the instance keeps running.`,
    onConfirm: () => {
      confirmAction.value = null
      void doStop(t, isNamed)
    },
  }
}

async function doStop(t: Tunnel, isNamed: boolean) {
  busy.value = { ...busy.value, [t.container]: true }
  message.value = ''
  try {
    const r = isNamed ? await stopNamedPreview(t.issue) : await stopTunnel(t.container)
    message.value = r.ok
      ? `Stopped ${t.issue ? 'sw-' + t.issue : t.container}.`
      : `Failed: ${(r as any).error || (r as any).output || 'unknown error'}`
    await load(true)
  } catch (e: any) {
    message.value = `Failed: ${e?.message || String(e)}`
  } finally {
    busy.value = { ...busy.value, [t.container]: false }
  }
}

async function copy(url: string) {
  message.value = (await copyToClipboard(url)) ? 'URL copied.' : 'Clipboard unavailable — copy manually.'
}

// Share: QR code (great for opening a preview on a phone).
const share = ref<{ url: string; dataUrl: string } | null>(null)
async function openShare(url: string) {
  try {
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 220 })
    share.value = { url, dataUrl }
  } catch { message.value = 'Could not generate QR.' }
}

// Stop idle: reap previews older than N hours.
const reapHours = ref(8)
const reaping = ref(false)
function requestReap() {
  confirmAction.value = {
    title: 'Stop idle previews',
    message: `Stop all preview tunnels older than ${reapHours.value}h? Instances keep running — only their tunnels stop.`,
    onConfirm: () => { confirmAction.value = null; void doReap() },
  }
}
async function doReap() {
  reaping.value = true
  message.value = ''
  try {
    const r = await reapTunnels(reapHours.value)
    message.value = r.ok ? `Stopped ${r.stopped?.length ?? 0} idle tunnel(s).` : `Failed: ${r.error || 'unknown error'}`
    await load(true)
  } catch (e: any) {
    message.value = `Failed: ${e?.message || String(e)}`
  } finally {
    reaping.value = false
  }
}

onMounted(() => { load(); loadConfig(); timer = setInterval(() => load(true), 10_000) })
onUnmounted(() => { if (timer) clearInterval(timer); stopLoginPoll() })
</script>

<template>
  <div class="p-6 max-w-5xl mx-auto">
    <div class="flex items-center justify-between mb-4">
      <div>
        <h1 class="text-lg text-white font-medium">Tunnels</h1>
        <p class="text-sm text-gray-500">Cloudflare preview tunnels across all instances.</p>
      </div>
      <div class="flex items-center gap-2">
        <!-- Stop idle previews older than N hours -->
        <div class="flex items-center gap-1 text-xs text-gray-500">
          <span>Stop idle &gt;</span>
          <input v-model.number="reapHours" type="number" min="1" class="w-12 h-7 box-border bg-surface border border-border rounded px-1 text-center text-white focus:outline-none focus:border-blue-500" />
          <span>h</span>
          <button
            class="px-2 py-1 rounded text-amber-300 hover:text-amber-200 disabled:opacity-50 inline-flex items-center gap-1"
            :disabled="reaping || !reapHours"
            @click="requestReap"
          >
            <span v-if="reaping" class="inline-block w-3 h-3 border-2 border-amber-300 border-t-transparent rounded-full animate-spin" />
            Stop idle
          </button>
        </div>
        <button
          class="px-3 py-1 text-sm rounded bg-surface text-gray-300 hover:text-white transition-colors inline-flex items-center gap-2 disabled:opacity-60"
          :disabled="loading || refreshing"
          @click="load(true)"
        >
          <span v-if="refreshing" class="inline-block w-3 h-3 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
          {{ refreshing ? 'Refreshing…' : 'Refresh' }}
        </button>
      </div>
    </div>

    <!-- Named-preview configuration (.swctl.conf) -->
    <div class="mb-4 rounded border border-white/10 bg-white/[0.02]">
      <button
        class="w-full flex items-center justify-between px-3 py-2 text-sm text-gray-300 hover:text-white"
        @click="toggleConfig"
      >
        <span class="flex items-center gap-2">
          <span class="text-gray-500">{{ showConfig ? '▾' : '▸' }}</span>
          Configuration
          <span v-if="!cfgDomain || !cfgTunnelId" class="text-xs text-amber-400/80">(named previews need a domain + tunnel)</span>
        </span>
        <span v-if="cfgDomain" class="text-xs text-gray-500 font-mono">sw-&lt;issue&gt;.{{ cfgDomain }}</span>
      </button>
      <div v-if="showConfig" class="px-3 pb-3 space-y-3 border-t border-white/5 pt-3">
        <p class="text-xs text-gray-500">Saved to the project's <code class="font-mono">.swctl.conf</code>.</p>

        <!-- Login / setup help: cloudflared login is an interactive browser
             flow, so it can't run from the UI — show the exact terminal steps. -->
        <!-- Cloudflare login status -->
        <div class="flex items-center gap-2 text-xs">
          <span v-if="accountLoading" class="inline-block w-3 h-3 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
          <template v-else-if="account.loggedIn">
            <span class="w-2 h-2 rounded-full bg-green-500 inline-block" />
            <span class="text-gray-300">Logged in to Cloudflare</span>
            <span v-if="account.zone" class="text-gray-500 font-mono">· {{ account.zone }}</span>
          </template>
          <template v-else>
            <span class="w-2 h-2 rounded-full bg-amber-500 inline-block" />
            <span class="text-amber-400/90">Not logged in to Cloudflare</span>
          </template>
        </div>

        <!-- Log in to Cloudflare straight from the UI. -->
        <div class="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            class="px-3 py-1.5 text-sm rounded font-medium bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-60 inline-flex items-center gap-2"
            :disabled="loginState === 'starting' || loginState === 'waiting'"
            @click="doLogin"
          >
            <span v-if="loginState === 'starting' || loginState === 'waiting'" class="inline-block w-3 h-3 border-2 border-white/70 border-t-transparent rounded-full animate-spin" />
            {{ loginState === 'waiting'
              ? 'Waiting for authorization…'
              : (account.loggedIn ? 'Log in with a different account' : 'Log in to Cloudflare') }}
          </button>
          <button
            v-if="loginState === 'waiting'"
            type="button"
            class="px-2 py-1 text-xs rounded text-gray-400 hover:text-white"
            @click="cancelLogin"
          >Cancel</button>
          <span v-if="loginState === 'done'" class="text-xs text-green-400">✓ Logged in — tunnel list refreshed.</span>
          <span v-if="loginState === 'error'" class="text-xs text-red-400">{{ loginError }}</span>
        </div>
        <p v-if="loginState === 'waiting'" class="text-xs text-gray-500">
          A browser tab opened to authorize. If it didn't,
          <a :href="loginUrl" target="_blank" rel="noopener" class="text-sky-400 hover:underline">click here</a>,
          pick the <span class="font-mono">{{ cfgDomain || 'your' }}</span> zone, and this updates automatically.
        </p>

        <!-- Already configured: creating another is redundant and would repoint
             DNS, so reassure + de-emphasise rather than offer an unguarded button. -->
        <div
          v-if="account.loggedIn && configuredTunnel"
          class="flex items-center gap-2 text-xs rounded border border-emerald-700/40 bg-emerald-900/10 px-3 py-2"
        >
          <svg class="w-3.5 h-3.5 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
          <span class="text-emerald-300">Tunnel already configured:</span>
          <span class="font-mono text-gray-200">{{ configuredTunnel.name }}</span>
          <span class="text-gray-500">— previews use this. No need to create another.</span>
        </div>

        <!-- Create a new tunnel (+ wildcard DNS) from the UI — onboarding for
             when none is wired yet. Hidden once one is configured (the server
             also refuses duplicates unless explicitly forced via confirm). -->
        <div v-if="account.loggedIn && !configuredTunnel" class="flex items-end gap-2 flex-wrap">
          <label class="block">
            <span class="text-xs text-gray-400">New tunnel name</span>
            <input
              v-model="newTunnelName"
              type="text"
              spellcheck="false"
              class="mt-1 w-48 h-9 box-border bg-surface border border-border rounded px-2 text-sm text-white font-mono focus:outline-none focus:border-blue-500"
            />
          </label>
          <button
            type="button"
            class="h-9 px-3 text-sm rounded font-medium bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-60 inline-flex items-center gap-2"
            :disabled="creating || !newTunnelName.trim()"
            :title="cfgDomain ? `Creates the tunnel and adds *.${cfgDomain} DNS` : 'Set a domain above first for wildcard DNS'"
            @click="createTunnel(false)"
          >
            <span v-if="creating" class="inline-block w-3 h-3 border-2 border-white/70 border-t-transparent rounded-full animate-spin" />
            {{ creating ? 'Creating…' : 'Create tunnel' }}
          </button>
          <span v-if="createMsg" class="text-xs text-gray-400">{{ createMsg }}</span>
        </div>
        <p v-else-if="account.loggedIn && createMsg" class="text-xs text-gray-400">{{ createMsg }}</p>

        <details class="text-xs text-gray-500 bg-black/20 rounded border border-white/5">
          <summary class="cursor-pointer px-2 py-1.5 hover:text-gray-300">Or set it up from the terminal</summary>
          <div class="px-2 pb-2 space-y-1 text-gray-400">
            <pre class="whitespace-pre-wrap font-mono text-[11px] text-gray-300 bg-black/30 rounded p-2 leading-relaxed">cloudflared tunnel login                       # pick the {{ cfgDomain || 'your-domain' }} zone
cloudflared tunnel create swctl-preview         # creates the tunnel + creds
cloudflared tunnel route dns swctl-preview '*.{{ cfgDomain || 'your-domain' }}'   # wildcard DNS</pre>
            <p>Then hit <span class="font-mono">↻</span> next to “Tunnel” to refresh the list.</p>
          </div>
        </details>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label class="block">
            <span class="text-xs text-gray-400 flex items-center h-5">Preview domain</span>
            <input
              v-model="cfgDomain"
              type="text"
              placeholder="y-tn.dev"
              spellcheck="false"
              class="mt-1 w-full h-9 box-border bg-surface border border-border rounded px-2 text-sm text-white font-mono focus:outline-none focus:border-blue-500"
            />
          </label>
          <label class="block">
            <span class="text-xs text-gray-400 flex items-center gap-2 h-5">
              Tunnel
              <span v-if="cfLoading" class="inline-block w-3 h-3 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
              <button type="button" class="text-gray-500 hover:text-gray-300" title="Reload tunnels" @click="loadCfTunnels">↻</button>
            </span>
            <!-- Dropdown when tunnels are discoverable; manual UUID fallback otherwise. -->
            <select
              v-if="cfTunnels.length"
              v-model="cfgTunnelId"
              class="mt-1 w-full h-9 box-border bg-surface border border-border rounded px-2 text-sm text-white focus:outline-none focus:border-blue-500"
            >
              <option value="" disabled>Select a tunnel…</option>
              <option v-for="t in cfTunnels" :key="t.id" :value="t.id">
                {{ t.name }}{{ t.hasCreds ? '' : ' — no local creds' }}
              </option>
              <option
                v-if="cfgTunnelId && !cfTunnels.some(t => t.id === cfgTunnelId)"
                :value="cfgTunnelId"
              >{{ cfgTunnelId }} (current)</option>
            </select>
            <input
              v-else
              v-model="cfgTunnelId"
              type="text"
              placeholder="502a0836-…  (tunnel UUID)"
              spellcheck="false"
              class="mt-1 w-full h-9 box-border bg-surface border border-border rounded px-2 text-sm text-white font-mono focus:outline-none focus:border-blue-500"
            />
            <span v-if="cfError" class="mt-1 block text-xs text-amber-400/80">{{ cfError }}</span>
            <span
              v-else-if="cfgTunnelId && cfTunnels.length && !cfTunnels.find(t => t.id === cfgTunnelId)?.hasCreds"
              class="mt-1 block text-xs text-amber-400/80"
            >No local credentials for this tunnel — run: cloudflared tunnel token --cred-file ~/.cloudflared/{{ cfgTunnelId }}.json &lt;name&gt;</span>
          </label>
        </div>
        <div class="flex items-center gap-3">
          <button
            class="px-3 py-1.5 text-sm rounded font-medium bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-60 inline-flex items-center gap-2"
            :disabled="cfgSaving"
            @click="saveConfig"
          >
            <span v-if="cfgSaving" class="inline-block w-3 h-3 border-2 border-white/70 border-t-transparent rounded-full animate-spin" />
            {{ cfgSaving ? 'Saving…' : 'Save' }}
          </button>
          <span v-if="cfgMessage" class="text-xs text-gray-400">{{ cfgMessage }}</span>
        </div>
      </div>
    </div>

    <p v-if="message" class="text-sm text-gray-400 mb-3">{{ message }}</p>
    <p v-if="error" class="text-sm text-red-400 mb-3">{{ error }}</p>

    <div v-if="loading && tunnels.length === 0" class="text-sm text-gray-500 flex items-center gap-2">
      <span class="inline-block w-3 h-3 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
      Loading…
    </div>

    <div v-else-if="tunnels.length === 0" class="text-sm text-gray-500">
      No tunnels running. Start one from an instance's Ops tab or <code>swctl preview &lt;issue&gt;</code>.
    </div>

    <table v-else class="w-full text-sm" :class="{ 'opacity-60': refreshing }">
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
        <tr
          v-for="t in tunnels"
          :key="t.container + ':' + t.issue"
          class="border-b border-white/5 transition-opacity"
          :class="{ 'opacity-50': busy[t.container] }"
        >
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
            <!-- v0.7.3 — every tunnel is behind basic auth.  Lock icon
                 is unconditional reassurance; if the user sees one
                 without the lock, something's broken (no opt-out exists). -->
            <span
              v-if="t.status === 'running'"
              class="inline-block mr-1 align-middle text-amber-400"
              title="Protected by HTTP Basic Auth (Caddy sidecar)"
            >🔒</span>
            <a v-if="t.url" :href="t.url" target="_blank" class="text-blue-400 hover:underline">{{ t.url }}</a>
            <span v-else class="text-gray-600">{{ t.type === 'named' ? '(named — see ~/.cloudflared)' : '—' }}</span>
          </td>
          <td class="py-2 pr-3 text-right whitespace-nowrap">
            <button
              v-if="t.url"
              class="px-2 py-0.5 text-xs rounded text-gray-400 hover:text-white disabled:opacity-50"
              :disabled="busy[t.container]"
              @click="copy(t.url)"
            >Copy</button>
            <button
              v-if="t.url"
              class="px-2 py-0.5 text-xs rounded text-gray-400 hover:text-white disabled:opacity-50"
              :disabled="busy[t.container]"
              @click="openShare(t.url)"
            >Share</button>
            <button
              class="px-2 py-0.5 text-xs rounded text-red-400 hover:text-red-300 disabled:opacity-50 inline-flex items-center gap-1"
              :disabled="busy[t.container]"
              @click="requestStop(t)"
            >
              <span v-if="busy[t.container]" class="inline-block w-3 h-3 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
              {{ busy[t.container] ? 'Stopping…' : 'Stop' }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <ConfirmDialog v-if="confirmAction" v-bind="confirmAction" @cancel="confirmAction = null" />

    <!-- Share: QR code for opening the preview on a phone -->
    <Teleport to="body">
      <div v-if="share" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50" @click.self="share = null">
        <div class="bg-surface border border-border rounded-lg p-6 shadow-2xl text-center">
          <h3 class="text-sm font-bold text-white mb-3">Scan to open the preview</h3>
          <img :src="share.dataUrl" alt="QR code" class="mx-auto rounded bg-white p-2" width="220" height="220" />
          <p class="mt-3 text-xs text-gray-400 font-mono break-all max-w-[240px]">{{ share.url }}</p>
          <div class="mt-4 flex justify-center gap-3">
            <button class="px-3 py-1.5 text-sm rounded bg-surface-dark text-gray-300 hover:text-white border border-border" @click="copy(share.url)">Copy URL</button>
            <button class="px-3 py-1.5 text-sm rounded bg-surface-dark text-gray-300 hover:text-white border border-border" @click="share = null">Close</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
