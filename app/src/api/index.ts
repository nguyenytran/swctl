import type { Instance, Project, ProjectConfig, GitHubResult, GitHubAuthStatus, ExternalWorktree, WorktreeItem } from '@/types'

const BASE = '/api'

export async function fetchInstances(): Promise<WorktreeItem[]> {
  const res = await fetch(`${BASE}/instances`)
  return res.json()
}

export async function fetchConfig(): Promise<ProjectConfig> {
  const res = await fetch(`${BASE}/config`)
  return res.json()
}

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(`${BASE}/projects`)
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

export async function fetchSettings(): Promise<{ editor: string; editorName: string; editorUrl: string }> {
  const res = await fetch(`${BASE}/settings`)
  return res.json()
}

export async function fetchGitHubStatus(): Promise<GitHubAuthStatus> {
  const res = await fetch(`${BASE}/github/status`)
  return res.json()
}

export async function fetchGitHubIssues(repo: string, state = 'open'): Promise<GitHubResult> {
  const params = new URLSearchParams({ repo, state })
  const res = await fetch(`${BASE}/github/issues?${params}`)
  return res.json()
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
}): string {
  const u = new URL(`${BASE}/stream/create`, window.location.origin)
  u.searchParams.set('issue', params.issue)
  u.searchParams.set('mode', params.mode)
  if (params.branch) u.searchParams.set('branch', params.branch)
  if (params.project) u.searchParams.set('project', params.project)
  if (params.plugin) u.searchParams.set('plugin', params.plugin)
  return u.pathname + u.search
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
