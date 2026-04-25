<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import {
  fetchConfig, saveConfig, testCli,
  KNOWN_BACKENDS,
  type UserConfig,
  type KnownBackend,
  type TestCliResult,
} from '@/api/config'

/**
 * /#/config — edits ~/.swctl/config.json.
 *
 * Sections:
 *   1. Features (read-only)         — gated flags like `resolveEnabled`.
 *   2. AI backends                  — pick which CLIs are available
 *      (multi-select), pick the default (single-select, restricted to
 *      the enabled set), test that each one actually works, and
 *      override its binary path / config dir.
 *
 * The page loads the full config on mount, lets the user mutate a local
 * draft, and POSTs the whole AI subtree back on Save.  Env vars still
 * win over config on the server; an empty input means "fall back".
 */

const path = ref('')
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const saved = ref(false)

const draft = ref<UserConfig>(emptyDraft())

// Per-backend test results from the /api/user-config/test-cli endpoint.
// Keyed by backend name; missing key = "never tested in this session".
const testResults = ref<Partial<Record<KnownBackend, TestCliResult>>>({})
const testing = ref<Partial<Record<KnownBackend, boolean>>>({})

function emptyDraft(): UserConfig {
  return {
    features: {},
    ai: {
      // Pre-seed with the back-compat default so the dropdown / checkboxes
      // have something coherent to bind against during the load round-trip.
      enabledBackends: ['claude'],
      defaultBackend: 'claude',
      claude: {},
      codex:  {},
    },
  }
}

function normaliseDraft(c: unknown, resolved?: { enabledBackends: KnownBackend[]; defaultBackend: KnownBackend }): UserConfig {
  const any = (c || {}) as Partial<UserConfig> & Record<string, unknown>
  const ai = (any.ai || {}) as NonNullable<UserConfig['ai']>
  const features = (any.features || {}) as NonNullable<UserConfig['features']>
  // Trust the server-provided `resolved` projection when present —
  // it's already applied the back-compat defaults (empty list → claude,
  // unknown values filtered).  Fall back to client-side derivation
  // when the server didn't include `resolved` (older server).
  const enabledFromServer = resolved?.enabledBackends ?? (
    Array.isArray(ai.enabledBackends) && ai.enabledBackends.length > 0
      ? ai.enabledBackends.filter(isKnownBackend)
      : ['claude']
  )
  const defaultFromServer = resolved?.defaultBackend ?? (
    isKnownBackend(ai.defaultBackend) && enabledFromServer.includes(ai.defaultBackend!)
      ? ai.defaultBackend
      : enabledFromServer[0]
  )
  return {
    features: { ...features },
    ai: {
      enabledBackends: enabledFromServer,
      defaultBackend:  defaultFromServer,
      claude: { ...(ai.claude || {}) },
      codex:  { ...(ai.codex  || {}) },
    },
  }
}

function isKnownBackend(v: unknown): v is KnownBackend {
  return v === 'claude' || v === 'codex'
}

onMounted(async () => {
  try {
    const resp = await fetchConfig()
    path.value = resp?.path || ''
    draft.value = normaliseDraft(resp?.config, resp?.resolved)
  } catch (e: any) {
    error.value = e?.message || 'Failed to load config'
    draft.value = emptyDraft()
  } finally {
    loading.value = false
  }
})

const resolveEnabled = computed<boolean>(() => draft.value.features.resolveEnabled === true)

/**
 * Two-way binding for "is backend X enabled?".  Toggling this updates
 * the array on the draft; if the user disables what was the default,
 * we auto-pick the first remaining enabled backend so we never end up
 * with `defaultBackend ∉ enabledBackends` (which the server would
 * 400 on Save).
 */
function isEnabled(b: KnownBackend): boolean {
  return (draft.value.ai.enabledBackends || []).includes(b)
}
function setEnabled(b: KnownBackend, on: boolean): void {
  const cur = new Set(draft.value.ai.enabledBackends || [])
  if (on) cur.add(b)
  else    cur.delete(b)
  // Preserve a stable order matching KNOWN_BACKENDS so the UI doesn't
  // shuffle when ticking/unticking.
  const next = KNOWN_BACKENDS.filter(x => cur.has(x))
  draft.value.ai.enabledBackends = next
  // Self-heal default: if the user disabled the current default,
  // shift to the first remaining enabled backend.  Don't 400 on Save
  // for a recoverable choice.
  if (next.length > 0 && !next.includes(draft.value.ai.defaultBackend!)) {
    draft.value.ai.defaultBackend = next[0]
  }
}

const enabledList = computed<KnownBackend[]>(() => draft.value.ai.enabledBackends || [])

const defaultBackend = computed<KnownBackend>({
  get: () => draft.value.ai.defaultBackend || enabledList.value[0] || 'claude',
  set: (v) => { draft.value.ai.defaultBackend = v },
})

/** Display label per backend — keeps copy in one place. */
function backendLabel(b: KnownBackend): string {
  return b === 'claude' ? 'Claude Code' : 'Codex CLI'
}

async function onTest(b: KnownBackend) {
  testing.value = { ...testing.value, [b]: true }
  // Clear the previous result while the new probe is in flight so
  // stale state can't be mistaken for fresh.
  testResults.value = { ...testResults.value, [b]: undefined }
  try {
    const r = await testCli(b)
    testResults.value = { ...testResults.value, [b]: r }
  } catch (e: any) {
    testResults.value = { ...testResults.value, [b]: { ok: false, bin: '', error: e?.message || 'request failed' } }
  } finally {
    testing.value = { ...testing.value, [b]: false }
  }
}

async function onSave() {
  saving.value = true
  error.value = ''
  saved.value = false
  try {
    // Send only the AI subtree.  Features stay read-only here; the
    // server merges, so anything we don't include is preserved.
    const clean: Partial<UserConfig> = {
      ai: {
        defaultBackend:  draft.value.ai.defaultBackend,
        enabledBackends: draft.value.ai.enabledBackends,
        claude: {
          bin:       strOrUndef(draft.value.ai.claude?.bin),
          configDir: strOrUndef(draft.value.ai.claude?.configDir),
        },
        codex: {
          bin:       strOrUndef(draft.value.ai.codex?.bin),
          configDir: strOrUndef(draft.value.ai.codex?.configDir),
        },
      },
    }
    const resp = await saveConfig(clean as UserConfig)
    draft.value = normaliseDraft(resp?.config, resp?.resolved)
    if (resp?.path) path.value = resp.path
    saved.value = true
    setTimeout(() => { saved.value = false }, 2000)
  } catch (e: any) {
    error.value = e?.message || 'Failed to save'
  } finally {
    saving.value = false
  }
}

function strOrUndef(v?: string): string | undefined {
  if (!v) return undefined
  const t = v.trim()
  return t === '' ? undefined : t
}
</script>

<template>
  <div class="max-w-3xl mx-auto p-6 space-y-6">
    <header>
      <h2 class="text-xl font-bold text-white">swctl config</h2>
      <p class="text-xs text-gray-500 mt-1">
        Edits
        <code class="bg-surface px-1 py-0.5 rounded text-gray-300">{{ path || '~/.swctl/config.json' }}</code>.
        The host CLI (<code class="text-gray-300">swctl</code>) reads the same file, so changes here
        take effect in the very next <code class="text-gray-300">swctl resolve …</code> run.
      </p>
      <p class="text-[11px] text-gray-600 mt-1">
        Feature flags are read-only here — edit <code>~/.swctl/config.json</code> directly
        or use <code>swctl config set features.&lt;name&gt; &lt;value&gt;</code>
        to flip them.  Env vars
        (<code>SWCTL_RESOLVE_ENABLED</code>,
         <code>SWCTL_CLAUDE_BIN</code>,
         <code>SWCTL_CODEX_BIN</code>,
         <code>CLAUDE_CONFIG_DIR</code>,
         <code>CODEX_CONFIG_DIR</code>,
         <code>SWCTL_RESOLVE_BACKEND</code>)
        still override these values when set.
      </p>
    </header>

    <div v-if="loading" class="text-sm text-gray-500">Loading…</div>
    <div
      v-if="error && !saving"
      class="text-sm text-red-400 border border-red-500/30 bg-red-500/10 rounded px-3 py-2"
    >{{ error }}</div>

    <template v-if="!loading && draft && draft.ai && draft.ai.claude && draft.ai.codex">
      <!-- Features (read-only) -->
      <section class="border border-border rounded-lg bg-surface p-4 space-y-3">
        <div class="flex items-center gap-2">
          <h3 class="text-sm font-semibold text-white">Features</h3>
          <span class="text-[10px] uppercase tracking-wider text-gray-500 border border-border rounded px-1.5 py-0.5">
            read-only
          </span>
        </div>

        <div>
          <label class="flex items-center gap-2.5 cursor-not-allowed select-none opacity-80">
            <input :checked="resolveEnabled" type="checkbox" class="swctl-checkbox" disabled aria-readonly="true" />
            <span class="text-sm text-gray-300">Resolve workflow</span>
            <span
              class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
              :class="resolveEnabled
                ? 'text-emerald-300 bg-emerald-500/10 border border-emerald-500/30'
                : 'text-gray-500 bg-surface-dark border border-border'"
            >{{ resolveEnabled ? 'enabled' : 'disabled' }}</span>
          </label>
          <p class="text-[11px] text-gray-500 mt-1 ml-[1.625rem] leading-relaxed">
            Exposes the <code>/resolve</code> route, the dashboard resolve widget,
            the Submit-Review action on the Diff tab, and the
            <code>swctl resolve …</code> CLI.
          </p>
        </div>
      </section>

      <!-- AI backends -->
      <section class="border border-border rounded-lg bg-surface p-4 space-y-5">
        <div>
          <h3 class="text-sm font-semibold text-white">AI backends</h3>
          <p class="text-[11px] text-gray-500 mt-0.5 leading-relaxed">
            Pick which CLIs are available for <code>swctl resolve</code> (multi-select),
            and which one is the default.  Per-issue selection in the Resolve
            page overrides the default — but only within the enabled set.
            Use <span class="text-gray-300">Test</span> to confirm a binary is reachable
            inside the swctl-ui container before kicking a real resolve.
          </p>
        </div>

        <!-- Enabled backends (multi-select) -->
        <div>
          <div class="text-xs font-medium text-gray-300 mb-2">Enabled backends</div>
          <div class="flex flex-col gap-2">
            <div v-for="b in KNOWN_BACKENDS" :key="`enabled-${b}`"
                 class="flex items-center gap-3 flex-wrap">
              <label class="flex items-center gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  class="swctl-checkbox"
                  :checked="isEnabled(b)"
                  :disabled="isEnabled(b) && enabledList.length === 1"
                  :title="isEnabled(b) && enabledList.length === 1 ? 'At least one backend has to stay enabled.' : ''"
                  @change="setEnabled(b, ($event.target as HTMLInputElement).checked)"
                />
                <span class="text-sm" :class="isEnabled(b) ? 'text-gray-200' : 'text-gray-500'">
                  {{ backendLabel(b) }}
                </span>
              </label>

              <button
                type="button"
                class="text-[11px] px-2 py-0.5 rounded border border-border bg-surface-dark text-gray-300 hover:bg-surface hover:border-gray-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                :disabled="testing[b]"
                @click="onTest(b)"
              >
                {{ testing[b] ? 'Testing…' : 'Test' }}
              </button>

              <!-- Inline test result.  Empty until the user clicks Test. -->
              <span v-if="testResults[b]" class="text-[11px] flex items-center gap-1 max-w-full">
                <template v-if="testResults[b]?.ok">
                  <span class="text-emerald-400">✓</span>
                  <span class="text-emerald-300/90 truncate">{{ testResults[b]?.version }}</span>
                  <span class="text-gray-600">({{ testResults[b]?.bin }})</span>
                </template>
                <template v-else>
                  <span class="text-red-400">✗</span>
                  <span class="text-red-300/90 truncate" :title="testResults[b]?.error">
                    {{ testResults[b]?.error }}
                  </span>
                </template>
              </span>
            </div>
          </div>
          <p class="text-[10px] text-gray-600 mt-2">
            At least one backend must stay enabled — otherwise the resolve
            flow has nothing to spawn and the server rejects the save.
          </p>
        </div>

        <!-- Default backend (single-select, restricted to enabled list) -->
        <div class="border-t border-border/50 pt-4">
          <div class="text-xs font-medium text-gray-300 mb-2">Default backend</div>
          <div class="flex items-center gap-2 flex-wrap">
            <select
              v-model="defaultBackend"
              class="bg-surface-dark border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
            >
              <option v-for="b in enabledList" :key="`default-${b}`" :value="b">
                {{ backendLabel(b) }}
              </option>
            </select>
            <span class="text-[11px] text-gray-500">
              used when an issue has no explicit per-issue choice.
            </span>
            <span v-if="defaultBackend === 'codex'" class="text-[11px] text-amber-500/80">experimental</span>
          </div>
        </div>

        <!-- Per-backend bin / configDir overrides -->
        <div class="border-t border-border/50 pt-4 space-y-4">
          <!-- Claude -->
          <div :class="isEnabled('claude') ? '' : 'opacity-50'">
            <h4 class="text-xs font-semibold text-gray-300 uppercase tracking-wide">
              {{ backendLabel('claude') }}
            </h4>
            <div class="grid grid-cols-[8rem_1fr] items-center gap-x-3 gap-y-2 mt-2">
              <label class="text-xs text-gray-400">Binary</label>
              <input
                v-model="draft.ai.claude!.bin"
                type="text"
                placeholder="claude"
                class="bg-surface-dark border border-border rounded px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
              />
              <label class="text-xs text-gray-400">Config dir</label>
              <input
                v-model="draft.ai.claude!.configDir"
                type="text"
                :placeholder="'~/.claude'"
                class="bg-surface-dark border border-border rounded px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <!-- Codex -->
          <div :class="isEnabled('codex') ? '' : 'opacity-50'">
            <h4 class="text-xs font-semibold text-gray-300 uppercase tracking-wide">
              {{ backendLabel('codex') }}
            </h4>
            <div class="grid grid-cols-[8rem_1fr] items-center gap-x-3 gap-y-2 mt-2">
              <label class="text-xs text-gray-400">Binary</label>
              <input
                v-model="draft.ai.codex!.bin"
                type="text"
                placeholder="codex"
                class="bg-surface-dark border border-border rounded px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
              />
              <label class="text-xs text-gray-400">Config dir</label>
              <input
                v-model="draft.ai.codex!.configDir"
                type="text"
                :placeholder="'~/.codex'"
                class="bg-surface-dark border border-border rounded px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <p class="text-[11px] text-gray-600">
            Leave any field empty to fall back to the env var (if set) and then the built-in default.
          </p>
        </div>
      </section>

      <!-- Actions -->
      <div class="flex items-center gap-3">
        <button
          class="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          :disabled="saving"
          @click="onSave"
        >
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
        <span v-if="saved" class="text-xs text-emerald-400">Saved</span>
        <span v-if="error" class="text-xs text-red-400">{{ error }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.swctl-checkbox {
  appearance: none;
  -webkit-appearance: none;
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
  border-radius: 3px;
  border: 1px solid rgb(107 114 128);
  background-color: rgb(24 24 27);
  cursor: pointer;
  transition: background-color 120ms, border-color 120ms;
  display: inline-block;
  vertical-align: middle;
  position: relative;
}
.swctl-checkbox:hover {
  border-color: rgb(156 163 175);
}
.swctl-checkbox:checked {
  background-color: rgb(37 99 235);
  border-color: rgb(37 99 235);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='3.5 8.5 6.5 11.5 12.5 4.5'/></svg>");
  background-size: 90% 90%;
  background-position: center;
  background-repeat: no-repeat;
}
.swctl-checkbox:focus-visible {
  outline: 2px solid rgb(59 130 246);
  outline-offset: 1px;
}
.swctl-checkbox:disabled {
  cursor: not-allowed;
}
.swctl-checkbox:disabled:not(:checked) {
  border-color: rgb(75 85 99);
  background-color: rgb(24 24 27);
}
.swctl-checkbox:disabled:hover {
  border-color: rgb(75 85 99);
}
</style>
