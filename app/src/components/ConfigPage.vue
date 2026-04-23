<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { fetchConfig, saveConfig, type UserConfig } from '@/api/config'

/**
 * /#/config — edits ~/.swctl/config.json.
 *
 * Sections:
 *   1. Features — toggles like `resolveEnabled` (gates the Resolve route + APIs).
 *   2. AI backend — default backend, claude/codex binary + config-dir overrides.
 *
 * The page loads the full config on mount, lets the user mutate a local
 * draft, and POSTs the whole object back on Save.  Env vars still win
 * over config on the server, so "leave empty to use the default" actually
 * means "use the env var if set, else the built-in default."
 */

const path = ref('')
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const saved = ref(false)

// Draft state — populated from GET /api/config, mutated by the form,
// posted back on Save.  Pre-seed the nested shape so v-model bindings
// (`draft.ai.claude!.bin`) don't blow up between mount and the first
// /api/config response.
const draft = ref<UserConfig>(emptyDraft())

function emptyDraft(): UserConfig {
  return {
    features: {},
    ai: {
      claude: {},
      codex:  {},
    },
  }
}

// Accept anything, always return a fully-populated UserConfig.  Must not
// throw, even on nulls / unexpected shapes — the /config page is the
// user's escape hatch for a broken config, so it has to keep rendering.
function normaliseDraft(c: unknown): UserConfig {
  const any = (c || {}) as Partial<UserConfig> & Record<string, unknown>
  const ai = (any.ai || {}) as NonNullable<UserConfig['ai']>
  const features = (any.features || {}) as NonNullable<UserConfig['features']>
  return {
    features: { ...features },
    ai: {
      defaultBackend: ai.defaultBackend,
      claude: { ...(ai.claude || {}) },
      codex:  { ...(ai.codex  || {}) },
    },
  }
}

onMounted(async () => {
  try {
    const resp = await fetchConfig()
    path.value = resp?.path || ''
    draft.value = normaliseDraft(resp?.config)
  } catch (e: any) {
    error.value = e?.message || 'Failed to load config'
    // Keep the form usable even if the initial load fails — user can
    // fill in values and hit Save to create the file from scratch.
    draft.value = emptyDraft()
  } finally {
    loading.value = false
  }
})

// Read-only: feature flags are not mutable from the UI.  They're
// displayed here so users can see the current state at a glance, but
// changes must happen via `swctl config set features.<name> <value>` or
// by editing ~/.swctl/config.json directly.  See the PUT payload below
// — `features` is deliberately NOT sent, so a future writable field on
// this page can't accidentally round-trip an old cached value back to
// disk.
const resolveEnabled = computed<boolean>(() => draft.value.features.resolveEnabled === true)

const defaultBackend = computed<'claude' | 'codex'>({
  get: () => draft.value.ai.defaultBackend || 'claude',
  set: (v) => { draft.value.ai.defaultBackend = v },
})

async function onSave() {
  saving.value = true
  error.value = ''
  saved.value = false
  try {
    // IMPORTANT: do NOT include `features` in the PUT payload.  That
    // subtree is treated as read-only by this page (users must edit
    // config.json or run `swctl config set` to flip a feature flag), and
    // omitting it here means a stale cached value can never be written
    // back to disk through a Save click.  The server's writeUserConfig()
    // merges, so existing `features.*` keys on disk are preserved
    // untouched.
    //
    // Also strip empty strings so the server treats them as "unset" and
    // falls back to env / defaults, rather than storing an empty override.
    const clean: Partial<UserConfig> = {
      ai: {
        defaultBackend: draft.value.ai.defaultBackend,
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
    draft.value = normaliseDraft(resp?.config)
    if (resp?.path) path.value = resp.path
    // Nothing here touches features — so no plugin/feature refetch is
    // required.  AI changes take effect on the next `swctl resolve …`
    // spawn (CLI reads the same file on every call).
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
        This page writes only the AI backend section.  Feature flags are
        read-only here — edit <code>~/.swctl/config.json</code> directly
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

        <p class="text-[11px] text-gray-500 leading-relaxed">
          Feature flags are intentionally not editable from the UI.  Edit
          <code class="bg-surface-dark px-1 py-0.5 rounded text-gray-300">{{ path || '~/.swctl/config.json' }}</code>
          directly (or run
          <code class="text-gray-300">swctl config set features.&lt;name&gt; &lt;value&gt;</code>
          on the host) so turning a gated feature on/off is a deliberate,
          auditable change — not a stray click.
        </p>

        <div>
          <label class="flex items-center gap-2.5 cursor-not-allowed select-none opacity-80">
            <input
              :checked="resolveEnabled"
              type="checkbox"
              class="swctl-checkbox"
              disabled
              aria-readonly="true"
            />
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
      <section class="border border-border rounded-lg bg-surface p-4 space-y-4">
        <div>
          <h3 class="text-sm font-semibold text-white">AI backend</h3>
          <p class="text-[11px] text-gray-500 mt-0.5">
            Pick the CLI that drives <code>swctl resolve</code>.  Per-issue
            selection in the Resolve page always overrides this default.
          </p>
        </div>

        <div class="flex items-center gap-4">
          <span class="text-xs text-gray-400 w-32">Default backend</span>
          <label class="flex items-center gap-1.5 cursor-pointer select-none">
            <input v-model="defaultBackend" type="radio" value="claude" class="accent-blue-500" />
            <span class="text-sm" :class="defaultBackend === 'claude' ? 'text-gray-200' : 'text-gray-500'">Claude Code</span>
          </label>
          <label class="flex items-center gap-1.5 cursor-pointer select-none">
            <input v-model="defaultBackend" type="radio" value="codex" class="accent-blue-500" />
            <span class="text-sm" :class="defaultBackend === 'codex' ? 'text-gray-200' : 'text-gray-500'">Codex CLI</span>
          </label>
          <span v-if="defaultBackend === 'codex'" class="text-[11px] text-amber-500/80">experimental</span>
        </div>

        <!-- Claude -->
        <div class="border-t border-border/50 pt-3 space-y-2">
          <h4 class="text-xs font-semibold text-gray-300 uppercase tracking-wide">Claude Code</h4>
          <div class="grid grid-cols-[8rem_1fr] items-center gap-x-3 gap-y-2">
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
        <div class="border-t border-border/50 pt-3 space-y-2">
          <h4 class="text-xs font-semibold text-gray-300 uppercase tracking-wide">Codex CLI</h4>
          <div class="grid grid-cols-[8rem_1fr] items-center gap-x-3 gap-y-2">
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
/* Custom checkbox — the browser default on dark backgrounds renders a
   tiny white box with a tick that's barely visible.  This makes the
   unchecked state a clear outlined square and the checked state a
   solid blue with a white ✓ drawn via a data-URL SVG background.
   `appearance: none` strips the native widget so nothing clashes. */
.swctl-checkbox {
  appearance: none;
  -webkit-appearance: none;
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
  border-radius: 3px;
  border: 1px solid rgb(107 114 128);          /* gray-500 */
  background-color: rgb(24 24 27);             /* bg-surface-dark-ish */
  cursor: pointer;
  transition: background-color 120ms, border-color 120ms;
  display: inline-block;
  vertical-align: middle;
  position: relative;
}
.swctl-checkbox:hover {
  border-color: rgb(156 163 175);              /* gray-400 */
}
.swctl-checkbox:checked {
  background-color: rgb(37 99 235);            /* blue-600 */
  border-color: rgb(37 99 235);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='3.5 8.5 6.5 11.5 12.5 4.5'/></svg>");
  background-size: 90% 90%;
  background-position: center;
  background-repeat: no-repeat;
}
.swctl-checkbox:focus-visible {
  outline: 2px solid rgb(59 130 246);          /* blue-500 */
  outline-offset: 1px;
}
/* Feature-flag checkboxes are intentionally read-only.  Keep the
   checked state fully legible (same blue + tick as live ones) but
   disable the hover affordance so it doesn't invite clicks. */
.swctl-checkbox:disabled {
  cursor: not-allowed;
}
.swctl-checkbox:disabled:not(:checked) {
  border-color: rgb(75 85 99);                 /* gray-600 */
  background-color: rgb(24 24 27);
}
.swctl-checkbox:disabled:hover {
  border-color: rgb(75 85 99);
}
</style>
