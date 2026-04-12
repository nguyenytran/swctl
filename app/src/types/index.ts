export interface Instance {
  issue: string
  issueId: string
  project: string
  projectSlug: string
  branch: string
  baseRef: string
  mode: 'qa' | 'dev'
  domain: string
  appUrl: string
  worktreePath: string
  dbName: string
  dbState: string
  composeProject: string
  createdAt: string
  containerStatus: 'running' | 'exited' | 'missing'
  containerInfo: string
  projectType: 'platform' | 'plugin-embedded' | 'plugin-external'
  pluginName: string
  linkedPlugins: string[]
  platformWorktreePath: string
  platformIssueId: string
  status: 'creating' | 'failed' | 'complete'
  failedAt: string
  changes: Changes
}

export interface Changes {
  migration: number
  entity: number
  admin: number
  storefront: number
  composer: number
  package: number
  backend: number
  frontend: number
}

export interface Project {
  name: string
  type: 'platform' | 'plugin-embedded' | 'plugin-external'
  path: string
  parent: string | null
  pluginDir: string | null
}

export interface ProjectConfig {
  SW_PROJECT?: string
  SW_BASE_BRANCH?: string
  [key: string]: string | undefined
}

export interface StreamEvent {
  line: string
  ts: number
}

export interface StreamDone {
  exitCode: number
  elapsed: number
}

export interface LinkedPR {
  number: number
  branch: string
  title: string
  state: string  // 'open' | 'draft' | 'closed' | 'merged'
}

export interface GitHubItem {
  number: number
  title: string
  labels: Array<{ name: string; color: string }>
  user: string
  branch: string | null
  isPR: boolean
  url: string
  category: 'assigned' | 'review-requested' | 'my-pr'
  issueType?: string | null
  linkedPRs?: LinkedPR[]
}

export interface GitHubResult {
  items: GitHubItem[]
  rateLimit?: { remaining: number; limit: number; reset: number }
  error?: string
  authUrl?: string
}

export interface GitHubAuthStatus {
  authenticated: boolean
  deviceFlowConfigured: boolean
  clientId?: string
  user?: { login: string; avatar_url: string; name: string | null }
}

export interface ExternalWorktree {
  kind: 'external'
  worktreePath: string
  branch: string | null
  head: string
  detached: boolean
  projectSlug: string
  source: 'claude' | 'codex' | 'swctl' | 'manual'
  registered: boolean
  repoPath?: string
  isPlugin: boolean
  pluginName: string | null
  parentProject: string | null
}

export type WorktreeItem = (Instance & { kind?: 'managed' }) | ExternalWorktree

export function isExternalWorktree(item: WorktreeItem): item is ExternalWorktree {
  return item.kind === 'external'
}

export type BatchJobStatus = 'pending' | 'running' | 'success' | 'failed'

export interface BatchJob {
  id: string
  issue: string
  branch: string
  plugin: string
  status: BatchJobStatus
}
