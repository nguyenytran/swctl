import type { Instance, Project, ProjectConfig, GitHubResult, GitHubAuthStatus, ExternalWorktree, WorktreeItem, Workflow, PreviewCreateResult } from '@/types'

const BASE = '/api'

export async function fetchInstances(): Promise<WorktreeItem[]> {
  const res = await fetch(`${BASE}/instances`)
  return res.json()
}

export interface CleanupState {
  diskSizeBytes: number | null
  lastActivity: string | null
  dirty: boolean
  ahead: number
  behind: number
  prState: 'open' | 'draft' | 'merged' | 'closed' | null
}

export async function fetchCleanupState(issueId: string): Promise<CleanupState | null> {
  try {
    const res = await fetch(`${BASE}/instances/${encodeURIComponent(issueId)}/cleanup-state`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export async function fetchCleanupStateBatch(issueIds: string[]): Promise<Record<string, CleanupState>> {
  if (issueIds.length === 0) return {}
  try {
    const res = await fetch(`${BASE}/instances/cleanup-state?issues=${encodeURIComponent(issueIds.join(','))}`)
    if (!res.ok) return {}
    return await res.json() as Record<string, CleanupState>
  } catch {
    return {}
  }
}

export async function fetchConfig(): Promise<ProjectConfig> {
  const res = await fetch(`${BASE}/config`)
  return res.json()
}

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(`${BASE}/projects`)
  return res.json()
}

export async function fetchWorkflows(): Promise<Workflow[]> {
  const res = await fetch(`${BASE}/workflows`)
  return res.json()
}

export async function addProject(data: {
  name: string
  path: string
  type: string
  parent?: string
  pluginDir?: string
}): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${BASE}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return res.json()
}

export async function removeProject(name: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/projects/${name}`, { method: 'DELETE' })
  return res.json()
}

export async function discoverPlugins(): Promise<{ ok: boolean; projects: Project[] }> {
  const res = await fetch(`${BASE}/projects/init`, { method: 'POST' })
  return res.json()
}

export async function restartInstance(issueId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/instances/${issueId}/restart`, { method: 'POST' })
  return res.json()
}

export async function stopInstance(issueId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/instances/${issueId}/stop`, { method: 'POST' })
  return res.json()
}

export async function startInstance(issueId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/instances/${issueId}/start`, { method: 'POST' })
  return res.json()
}

// ---------------------------------------------------------------------------
// Snapshot / restore
// ---------------------------------------------------------------------------

export interface Snapshot {
  name: string
  size: string
  created: string
}

export async function listSnapshots(issueId: string): Promise<{ ok: boolean; snapshots: Snapshot[]; error?: string }> {
  const res = await fetch(`${BASE}/instances/${issueId}/snapshots`)
  return res.json()
}

export async function createSnapshot(issueId: string, name?: string): Promise<{ ok: boolean; output: string; error?: string }> {
  const res = await fetch(`${BASE}/instances/${issueId}/snapshots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(name ? { name } : {}),
  })
  return res.json()
}

export async function deleteSnapshot(issueId: string, name: string): Promise<{ ok: boolean; output: string }> {
  const res = await fetch(`${BASE}/instances/${issueId}/snapshots/${encodeURIComponent(name)}`, { method: 'DELETE' })
  return res.json()
}

export async function restoreSnapshot(issueId: string, name: string): Promise<{ ok: boolean; output: string }> {
  const res = await fetch(`${BASE}/instances/${issueId}/snapshots/${encodeURIComponent(name)}/restore`, { method: 'POST' })
  return res.json()
}

// ---------------------------------------------------------------------------
// Preview (Cloudflare quick-tunnel)
// ---------------------------------------------------------------------------

export interface PreviewStatus {
  ok: boolean
  running: boolean
  url: string | null
  output?: string
}

export async function getPreviewStatus(issueId: string): Promise<PreviewStatus> {
  const res = await fetch(`${BASE}/instances/${issueId}/preview`)
  return res.json()
}

export async function startPreview(issueId: string): Promise<{ ok: boolean; url: string | null; output: string }> {
  const res = await fetch(`${BASE}/instances/${issueId}/preview`, { method: 'POST' })
  return res.json()
}

export async function stopPreview(issueId: string): Promise<{ ok: boolean; output: string }> {
  const res = await fetch(`${BASE}/instances/${issueId}/preview`, { method: 'DELETE' })
  return res.json()
}

// PR status per instance issue id.
export interface PrInfo { number?: number; title?: string; state?: string; url?: string; draft?: boolean; repo?: string }

export async function getInstancePrs(ids: string[]): Promise<Record<string, PrInfo | null>> {
  if (!ids.length) return {}
  const res = await fetch(`${BASE}/instances/prs?ids=${encodeURIComponent(ids.join(','))}`)
  return res.json()
}

// Per-instance observability (CPU/RAM + HTTP health), keyed by compose project.
export interface InstanceObservability { cpu: string; mem: string; healthy: boolean | null }

export async function getInstanceObservability(): Promise<Record<string, InstanceObservability>> {
  const res = await fetch(`${BASE}/instances/observability`)
  return res.json()
}

// Named-preview tunnel configuration (project .swctl.conf).
export interface TunnelConfig { domain: string; tunnelId: string }

export interface CloudflaredTunnel { id: string; name: string; hasCreds: boolean }

export async function listCloudflaredTunnels(): Promise<{ ok: boolean; tunnels: CloudflaredTunnel[]; error?: string }> {
  const res = await fetch(`${BASE}/cloudflared/tunnels`)
  return res.json()
}

export interface CloudflaredAccount { loggedIn: boolean; accountId?: string; zoneId?: string; zone?: string }

export async function getCloudflaredAccount(): Promise<CloudflaredAccount> {
  const res = await fetch(`${BASE}/cloudflared/account`)
  return res.json()
}

// Interactive Cloudflare login (browser auth, driven from the UI).
export async function startCloudflaredLogin(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const res = await fetch(`${BASE}/cloudflared/login`, { method: 'POST' })
  return res.json()
}

export async function cloudflaredLoginStatus(): Promise<{ state: 'idle' | 'waiting' | 'done' | 'error'; error?: string }> {
  const res = await fetch(`${BASE}/cloudflared/login/status`)
  return res.json()
}

export async function cancelCloudflaredLogin(): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/cloudflared/login`, { method: 'DELETE' })
  return res.json()
}

export async function createCloudflaredTunnel(name: string, domain: string): Promise<{ ok: boolean; id?: string; name?: string; dnsWarning?: string; error?: string }> {
  const res = await fetch(`${BASE}/cloudflared/create-tunnel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, domain }),
  })
  return res.json()
}

export async function getTunnelConfig(): Promise<TunnelConfig> {
  const res = await fetch(`${BASE}/tunnel-config`)
  return res.json()
}

export async function saveTunnelConfig(cfg: TunnelConfig): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${BASE}/tunnel-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  })
  return res.json()
}

// Named preview (stable sw-<issue>.<domain>) — per instance.
export async function getNamedPreview(issueId: string): Promise<{ ok: boolean; running: boolean; url: string | null }> {
  const res = await fetch(`${BASE}/instances/${issueId}/named-preview`)
  return res.json()
}

export async function startNamedPreview(issueId: string): Promise<{ ok: boolean; url: string | null; output: string }> {
  const res = await fetch(`${BASE}/instances/${issueId}/named-preview`, { method: 'POST' })
  return res.json()
}

export async function stopNamedPreview(issueId: string): Promise<{ ok: boolean; output: string }> {
  const res = await fetch(`${BASE}/instances/${issueId}/named-preview`, { method: 'DELETE' })
  return res.json()
}

// Reset an instance to a clean DB (re-clone the base). Destructive.
export async function resetInstanceDb(issueId: string): Promise<{ ok: boolean; output: string }> {
  const res = await fetch(`${BASE}/instances/${issueId}/reset`, { method: 'POST' })
  return res.json()
}

// Fleet-wide tunnel management (quick + named) for the Tunnels panel.
export interface Tunnel {
  issue: string
  type: 'quick' | 'named' | string
  container: string
  status: string
  url: string
}

export async function getTunnels(): Promise<{ ok: boolean; tunnels: Tunnel[] }> {
  const res = await fetch(`${BASE}/tunnels`)
  return res.json()
}

export async function stopTunnel(container: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  const res = await fetch(`${BASE}/tunnels/${encodeURIComponent(container)}`, { method: 'DELETE' })
  return res.json()
}

export async function reapTunnels(hours: number): Promise<{ ok: boolean; stopped?: string[]; error?: string }> {
  const res = await fetch(`${BASE}/tunnels/reap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hours }),
  })
  return res.json()
}

export async function fetchDirectories(dirPath?: string): Promise<{
  current: string
  parent: string
  dirs: Array<{ name: string; path: string; hasSwctlConf: boolean; hasGit: boolean }>
  hasSwctlConf: boolean
  hasGit: boolean
  projectName: string
  baseBranch: string
  isRoot: boolean
}> {
  const params = dirPath ? `?path=${encodeURIComponent(dirPath)}` : ''
  const res = await fetch(`${BASE}/browse${params}`)
  return res.json()
}

export async function initProjectConfig(data: {
  path: string
  name: string
  workflow: string
  baseBranch: string
  phpImage: string
  shareNetwork: string
  dbHost: string
  dbPort: string
  dbRootUser: string
  dbRootPassword: string
  dbNamePrefix: string
  dbSharedName: string
}): Promise<{ ok: boolean; error?: string; name?: string }> {
  const res = await fetch(`${BASE}/projects/init-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return res.json()
}

export async function fetchDiff(issueId: string): Promise<{ stat: string; diff: string }> {
  const res = await fetch(`${BASE}/diff?issueId=${encodeURIComponent(issueId)}`)
  return res.json()
}

export async function fetchPlugins(project: string): Promise<string[]> {
  const res = await fetch(`${BASE}/plugins?project=${encodeURIComponent(project)}`)
  return res.json()
}

export async function fetchBranches(project: string, query?: string, plugin?: string): Promise<string[]> {
  const params = new URLSearchParams({ project })
  if (query) params.set('q', query)
  if (plugin) params.set('plugin', plugin)
  const res = await fetch(`${BASE}/branches?${params}`)
  return res.json()
}

export async function execCommand(issueId: string, command: string): Promise<{ ok: boolean; output: string }> {
  const res = await fetch(`${BASE}/instances/${issueId}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
  })
  return res.json()
}

export async function killExec(issueId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/instances/${issueId}/kill-exec`, { method: 'POST' })
  return res.json()
}

export async function killWorktreeExec(issueId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/instances/${issueId}/kill-worktree-exec`, { method: 'POST' })
  return res.json()
}

export async function fetchSettings(): Promise<{
  editor: string; editorName: string; editorUrl: string

}> {
  const res = await fetch(`${BASE}/settings`)
  return res.json()
}

export async function fetchGitHubStatus(): Promise<GitHubAuthStatus> {
  const res = await fetch(`${BASE}/github/status`)
  return res.json()
}

export async function fetchGitHubIssues(
  org?: string,
  labels?: string[],
): Promise<GitHubResult> {
  const params = new URLSearchParams()
  if (org) params.set('org', org)
  // Passing an empty string is intentional: the server treats "labels present
  // but empty" as "user removed every chip" → no assigned items. Omit the
  // param entirely to disable the label filter.
  if (labels !== undefined) params.set('labels', labels.join(','))
  const res = await fetch(`${BASE}/github/issues?${params}`)
  return res.json()
}

export async function fetchDefaultIssueLabels(): Promise<string[]> {
  try {
    const res = await fetch(`${BASE}/github/labels/defaults`)
    const body = await res.json() as { labels?: string[] }
    return body.labels || []
  } catch {
    return []
  }
}

export async function githubLogout(): Promise<void> {
  await fetch(`${BASE}/github/logout`, { method: 'POST' })
}

export async function requestDeviceCode(): Promise<{
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
} | { error: string }> {
  const res = await fetch(`${BASE}/github/device-code`, { method: 'POST' })
  return res.json()
}

export async function pollDeviceAuth(deviceCode: string): Promise<{
  status: 'authorized' | 'pending' | 'slow_down' | 'expired' | 'error'
  error?: string
}> {
  const res = await fetch(`${BASE}/github/device-poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  })
  return res.json()
}

export function buildCreateUrl(params: {
  issue: string
  mode: string
  branch?: string
  project?: string
  plugin?: string
  deps?: string
  adoptWorktreePath?: string
}): string {
  const u = new URL(`${BASE}/stream/create`, window.location.origin)
  u.searchParams.set('issue', params.issue)
  u.searchParams.set('mode', params.mode)
  if (params.branch) u.searchParams.set('branch', params.branch)
  if (params.project) u.searchParams.set('project', params.project)
  if (params.plugin) u.searchParams.set('plugin', params.plugin)
  if (params.deps) u.searchParams.set('deps', params.deps)
  if (params.adoptWorktreePath) u.searchParams.set('adoptWorktreePath', params.adoptWorktreePath)
  return u.pathname + u.search
}

export interface PrResolution {
  ok: boolean
  issue?: string
  branch?: string
  title?: string
  state?: string
  repo?: string
  pr?: number
  error?: string
}

export async function resolvePr(ref: string, repo?: string): Promise<PrResolution> {
  const u = new URL(`${BASE}/pr/resolve`, window.location.origin)
  u.searchParams.set('ref', ref)
  if (repo) u.searchParams.set('repo', repo)
  const res = await fetch(u.pathname + u.search)
  return res.json()
}

export function buildStreamUrl(action: string, params: Record<string, string>): string {
  const u = new URL(`${BASE}/stream/${action}`, window.location.origin)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.pathname + u.search
}

export async function setupInstance(issueId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${BASE}/instances/${issueId}/setup`, { method: 'POST' })
  return res.json()
}

export async function linkExternalWorktree(data: {
  worktreePath: string
  issueId: string
  project: string
}): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${BASE}/external-worktrees/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return res.json()
}

export function buildRefreshExternalUrl(worktreePath: string, project: string): string {
  const u = new URL(`${BASE}/stream/refresh-external`, window.location.origin)
  u.searchParams.set('worktreePath', worktreePath)
  u.searchParams.set('project', project)
  return u.pathname + u.search
}

export async function fetchCheckoutState(): Promise<{ active: boolean; issueId: string; previousBranch: string }> {
  const res = await fetch(`${BASE}/checkout-state`)
  return res.json()
}

export async function previewCreate(params: {
  issue: string
  branch?: string
  project?: string
  mode?: string
  plugin?: string
}): Promise<PreviewCreateResult> {
  const q = new URLSearchParams({ issue: params.issue })
  if (params.branch) q.set('branch', params.branch)
  if (params.project) q.set('project', params.project)
  if (params.mode) q.set('mode', params.mode)
  if (params.plugin) q.set('plugin', params.plugin)
  const res = await fetch(`${BASE}/preview-create?${q}`)
  return res.json()
}

export async function preflight(params: {
  issue: string
  project?: string
  branch?: string
  mode?: string
}): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  const q = new URLSearchParams({ issue: params.issue })
  if (params.project) q.set('project', params.project)
  if (params.branch) q.set('branch', params.branch)
  if (params.mode) q.set('mode', params.mode)
  const res = await fetch(`${BASE}/preflight?${q}`)
  return res.json()
}

export async function fetchSystemInfo(): Promise<{
  cpuCores: number
  freeMemoryGB: number
  totalMemoryGB: number
  suggestedConcurrency: number
}> {
  const res = await fetch(`${BASE}/system-info`)
  return res.json()
}

