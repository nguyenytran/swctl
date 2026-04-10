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

export type BatchJobStatus = 'pending' | 'running' | 'success' | 'failed'

export interface BatchJob {
  id: string
  issue: string
  branch: string
  plugin: string
  status: BatchJobStatus
}
