import type { Ref } from 'vue'
import type { Instance } from './index'

// ---------- Manifest (server-provided) ----------

export interface PluginManifest {
  id: string
  name: string
  version: string
  entry: string              // relative path to ESM entry, e.g. "index.js"
  description?: string
  author?: string
  // Resolved URL the browser should import (filled by server/composable)
  entryUrl?: string
}

// ---------- Context passed to plugin callbacks ----------

export interface PluginApi {
  exec(issueId: string, command: string): Promise<{ ok: boolean; output: string; exitCode: number }>
  fetch(path: string, init?: RequestInit): Promise<any>
  startInstance(issueId: string): Promise<any>
  stopInstance(issueId: string): Promise<any>
  restartInstance(issueId: string): Promise<any>
  refreshInstances(): Promise<void>
}

export interface PluginEvents {
  on(event: string, handler: (payload: any) => void): () => void
}

export interface PluginUi {
  toast(msg: string, kind?: 'info' | 'success' | 'warn' | 'error'): void
  confirm(msg: string): Promise<boolean>
}

export interface PluginContext {
  instance?: Instance
  api: PluginApi
  events: PluginEvents
  ui: PluginUi
  instances: Ref<Instance[]>
  activeProject: Ref<string | null>
}

// ---------- Registrations ----------

export type PluginRender = (container: HTMLElement, ctx: PluginContext) => (() => void) | void

export interface PluginTab {
  id: string
  label: string
  icon?: string
  render: PluginRender
  condition?: (instance: Instance) => boolean
}

export interface PluginAction {
  id: string
  label: string
  scope: 'instance' | 'global'
  icon?: string
  handler: (ctx: PluginContext) => void | Promise<void>
  condition?: (instance: Instance) => boolean
}

export type PluginWidgetLocation = 'dashboard-sidebar' | 'dashboard-bottom'

export interface PluginWidget {
  id: string
  location: PluginWidgetLocation
  title?: string
  render: PluginRender
}

export interface PluginRoute {
  path: string               // no leading `/` needed; normalised by loader
  label: string
  icon?: string
  render: PluginRender
}

// ---------- Plugin entry-point shape (default export of index.js) ----------

export interface Plugin {
  id: string
  tabs?: PluginTab[]
  actions?: PluginAction[]
  widgets?: PluginWidget[]
  routes?: PluginRoute[]
}

// ---------- Registered (internal shape: manifest + entry, with owner metadata) ----------

export interface RegisteredTab extends PluginTab {
  pluginId: string
}
export interface RegisteredAction extends PluginAction {
  pluginId: string
}
export interface RegisteredWidget extends PluginWidget {
  pluginId: string
}
export interface RegisteredRoute extends PluginRoute {
  pluginId: string
}
