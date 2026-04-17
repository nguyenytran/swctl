import { computed, ref } from 'vue'
import type { Router } from 'vue-router'
import type {
  Plugin,
  PluginContext,
  PluginManifest,
  RegisteredAction,
  RegisteredRoute,
  RegisteredTab,
  RegisteredWidget,
} from '@/types/plugin'
import {
  execCommand,
  startInstance,
  stopInstance,
  restartInstance,
  fetchInstances,
} from '@/api'
import { useInstances } from './useInstances'
import { useActiveProject } from './useActiveProject'

// Module-level singletons (shared across components)
const manifests = ref<PluginManifest[]>([])
const tabs = ref<RegisteredTab[]>([])
const actions = ref<RegisteredAction[]>([])
const widgets = ref<RegisteredWidget[]>([])
const routes = ref<RegisteredRoute[]>([])
const initialized = ref(false)

// Central event bus used by PluginContext.events
type Handler = (payload: any) => void
const listeners = new Map<string, Set<Handler>>()

function busOn(event: string, handler: Handler): () => void {
  let set = listeners.get(event)
  if (!set) { set = new Set(); listeners.set(event, set) }
  set.add(handler)
  return () => { set!.delete(handler) }
}

export function emitPluginEvent(event: string, payload: any) {
  listeners.get(event)?.forEach(h => { try { h(payload) } catch (err) { console.error('[plugin event]', err) } })
}

// Build a context object that plugins receive on every callback
export function buildPluginContext(extra?: Partial<PluginContext>): PluginContext {
  const { instances } = useInstances()
  const { activeProjectName } = useActiveProject()

  return {
    instance: extra?.instance,
    api: {
      exec: (issueId, command) => execCommand(issueId, command).then(r => ({
        ok: r.ok,
        output: r.output,
        exitCode: r.ok ? 0 : 1,
      })),
      fetch: async (path, init) => {
        const url = path.startsWith('/') ? path : `/api/${path}`
        const res = await fetch(url, init)
        const ct = res.headers.get('content-type') || ''
        return ct.includes('application/json') ? res.json() : res.text()
      },
      startInstance,
      stopInstance,
      restartInstance,
      refreshInstances: async () => { await fetchInstances() },
    },
    events: {
      on: busOn,
    },
    ui: {
      toast: (msg, kind) => {
        // Minimal impl: log + browser notification via alert only for errors
        const tag = kind ? `[${kind}]` : '[info]'
        console.log(`[plugin ui] ${tag}`, msg)
        if (kind === 'error') console.error(msg)
      },
      confirm: async (msg) => window.confirm(msg),
    },
    instances,
    activeProject: activeProjectName,
  }
}

/**
 * Dynamically import all plugins listed by the server and register their
 * extension points. Safe to call multiple times — clears prior registrations.
 */
async function loadAll(router?: Router): Promise<void> {
  // Clear prior registrations
  tabs.value = []
  actions.value = []
  widgets.value = []

  // Remove previously-registered plugin routes from the router
  if (router) {
    for (const r of routes.value) {
      try { router.removeRoute(routeName(r.pluginId, r.path)) } catch {}
    }
  }
  routes.value = []

  let list: PluginManifest[] = []
  try {
    const res = await fetch('/api/plugins/list')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    list = await res.json()
  } catch (err) {
    console.warn('[plugins] failed to list:', err)
    manifests.value = []
    return
  }

  manifests.value = list

  for (const m of list) {
    const entryUrl = m.entryUrl || `/api/plugins/${m.id}/${m.entry}`
    try {
      const mod = await import(/* @vite-ignore */ entryUrl)
      const plugin: Plugin | undefined = mod?.default
      if (!plugin || typeof plugin !== 'object') {
        console.warn(`[plugins] ${m.id}: default export is not a plugin object`)
        continue
      }

      if (Array.isArray(plugin.tabs)) {
        for (const t of plugin.tabs) {
          tabs.value.push({ ...t, pluginId: m.id })
        }
      }
      if (Array.isArray(plugin.actions)) {
        for (const a of plugin.actions) {
          actions.value.push({ ...a, pluginId: m.id })
        }
      }
      if (Array.isArray(plugin.widgets)) {
        for (const w of plugin.widgets) {
          widgets.value.push({ ...w, pluginId: m.id })
        }
      }
      if (Array.isArray(plugin.routes) && router) {
        for (const r of plugin.routes) {
          const rr: RegisteredRoute = { ...r, pluginId: m.id }
          routes.value.push(rr)
          router.addRoute({
            path: normalisePath(rr.path),
            name: routeName(m.id, rr.path),
            component: () => import('@/components/PluginPage.vue'),
            meta: { plugin: { id: m.id, path: rr.path } },
          })
        }
      }
    } catch (err) {
      console.error(`[plugins] failed to load ${m.id}:`, err)
    }
  }
}

function routeName(pluginId: string, p: string): string {
  return `plugin:${pluginId}:${p}`
}

function normalisePath(p: string): string {
  if (!p) return '/'
  return p.startsWith('/') ? p : `/${p}`
}

// Lookups used by components when rendering plugin content
export function findTab(pluginId: string, tabId: string): RegisteredTab | undefined {
  return tabs.value.find(t => t.pluginId === pluginId && t.id === tabId)
}

export function findRoute(pluginId: string, path: string): RegisteredRoute | undefined {
  return routes.value.find(r => r.pluginId === pluginId && r.path === path)
}

export function usePlugins() {
  return {
    manifests: computed(() => manifests.value),
    tabs: computed(() => tabs.value),
    actions: computed(() => actions.value),
    widgets: computed(() => widgets.value),
    routes: computed(() => routes.value),
    initialized: computed(() => initialized.value),
    async init(router: Router) {
      if (initialized.value) return
      await loadAll(router)
      initialized.value = true
    },
    async reload(router: Router) {
      await loadAll(router)
    },
    findTab,
    findRoute,
  }
}
