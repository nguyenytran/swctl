<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { fetchGitHubStatus, githubLogout, requestDeviceCode, pollDeviceAuth } from '@/api'
import type { GitHubAuthStatus } from '@/types'

const auth = ref<GitHubAuthStatus | null>(null)
const deviceCode = ref<{ device_code: string; user_code: string; verification_uri: string; interval: number } | null>(null)
const polling = ref(false)
const error = ref('')
const showDropdown = ref(false)
const copied = ref(false)
let pollTimer: ReturnType<typeof setTimeout> | null = null

onMounted(() => {
  fetchGitHubStatus().then(s => { auth.value = s }).catch(() => {})
})

onUnmounted(() => {
  if (pollTimer) clearTimeout(pollTimer)
})

async function startDeviceFlow() {
  error.value = ''
  deviceCode.value = null
  showDropdown.value = false

  const result = await requestDeviceCode()
  if ('error' in result) {
    error.value = result.error
    return
  }
  deviceCode.value = {
    device_code: result.device_code,
    user_code: result.user_code,
    verification_uri: result.verification_uri,
    interval: result.interval || 5,
  }
  window.open(result.verification_uri, '_blank')
  polling.value = true
  schedulePoll()
}

function schedulePoll() {
  if (!deviceCode.value) return
  const interval = (deviceCode.value.interval || 5) * 1000
  pollTimer = setTimeout(async () => {
    if (!deviceCode.value) return
    const result = await pollDeviceAuth(deviceCode.value.device_code)
    if (result.status === 'authorized') {
      polling.value = false
      deviceCode.value = null
      const status = await fetchGitHubStatus()
      auth.value = status
    } else if (result.status === 'expired') {
      polling.value = false
      error.value = 'Code expired. Try again.'
      deviceCode.value = null
    } else if (result.status === 'error') {
      polling.value = false
      error.value = result.error || 'Authentication failed'
      deviceCode.value = null
    } else {
      if (result.status === 'slow_down' && deviceCode.value) {
        deviceCode.value.interval = (deviceCode.value.interval || 5) + 5
      }
      schedulePoll()
    }
  }, interval)
}

function cancelFlow() {
  if (pollTimer) clearTimeout(pollTimer)
  polling.value = false
  deviceCode.value = null
  error.value = ''
}

async function copyCode() {
  if (deviceCode.value) {
    await navigator.clipboard.writeText(deviceCode.value.user_code)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  }
}

async function handleLogout() {
  await githubLogout()
  auth.value = { authenticated: false, deviceFlowConfigured: auth.value?.deviceFlowConfigured ?? false }
  showDropdown.value = false
}

// Close dropdown on outside click
function onClickOutside(e: MouseEvent) {
  const el = (e.target as HTMLElement).closest('.gh-auth-btn')
  if (!el) showDropdown.value = false
}

onMounted(() => document.addEventListener('click', onClickOutside))
onUnmounted(() => document.removeEventListener('click', onClickOutside))

// Expose auth state so parent can use it
defineExpose({ auth })
</script>

<template>
  <!-- Not configured: hide entirely -->
  <div v-if="auth && (auth.authenticated || auth.deviceFlowConfigured)" class="gh-auth-btn relative">
    <!-- Authenticated: show avatar -->
    <template v-if="auth.authenticated">
      <button
        class="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-surface transition-colors"
        @click.stop="showDropdown = !showDropdown"
      >
        <img :src="auth.user?.avatar_url" class="w-5 h-5 rounded-full" />
        <span class="text-xs text-gray-300">{{ auth.user?.login }}</span>
        <svg class="w-3 h-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
      </button>
      <!-- Dropdown -->
      <div
        v-if="showDropdown"
        class="absolute right-0 top-full mt-1 w-40 bg-surface border border-border rounded shadow-lg py-1 z-50"
      >
        <button
          class="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-surface-hover transition-colors"
          @click="handleLogout"
        >Logout</button>
      </div>
    </template>

    <!-- Device Flow in progress -->
    <template v-else-if="deviceCode">
      <div class="flex items-center gap-2 bg-surface border border-border rounded px-3 py-1.5">
        <span class="text-[10px] text-gray-400">Code:</span>
        <code class="text-xs text-white font-bold tracking-widest select-all">{{ deviceCode.user_code }}</code>
        <button
          class="text-gray-500 hover:text-white transition-colors"
          @click="copyCode"
          :title="copied ? 'Copied!' : 'Copy code'"
        >
          <svg v-if="!copied" class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke-width="2"/></svg>
          <svg v-else class="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
        </button>
        <a
          :href="deviceCode.verification_uri"
          target="_blank"
          class="text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
        >Open GitHub</a>
        <span v-if="polling" class="text-[10px] text-blue-400 animate-pulse">Waiting...</span>
        <button
          class="text-gray-600 hover:text-gray-300 transition-colors text-xs ml-1"
          @click="cancelFlow"
        >&#10005;</button>
      </div>
    </template>

    <!-- Not authenticated: show login button -->
    <template v-else>
      <button
        class="flex items-center gap-1.5 px-2.5 py-1 text-xs text-gray-400 hover:text-white border border-border rounded hover:bg-surface transition-colors"
        @click="startDeviceFlow"
      >
        <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        Login
      </button>
      <div v-if="error" class="absolute right-0 top-full mt-1 text-[10px] text-red-400 bg-surface border border-red-600/20 rounded px-2 py-1 whitespace-nowrap z-50">
        {{ error }}
      </div>
    </template>
  </div>
</template>
