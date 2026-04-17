const BASE = '/api/skill/resolve'

export interface ResolveRun {
  issue: string
  project?: string
  mode?: string
  startedAt: string
  finishedAt?: string
  status: 'running' | 'done' | 'failed'
  exitCode?: number
}

export interface PrInfo {
  number?: number
  title?: string
  state?: string
  url?: string
  draft?: boolean
  notFound?: boolean
}

export async function fetchResolveRuns(): Promise<ResolveRun[]> {
  const res = await fetch(`${BASE}/runs`)
  return res.json()
}

export function buildResolveStreamUrl(issue: string, project?: string): string {
  const params = new URLSearchParams({ issue })
  if (project) params.set('project', project)
  return `${BASE}/stream?${params}`
}

export function buildAskStreamUrl(issueId: string, message: string): string {
  const params = new URLSearchParams({ issueId, message })
  return `${BASE}/ask?${params}`
}

export async function finishResolve(issue: string, exitCode: number): Promise<void> {
  await fetch(`${BASE}/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issue, exitCode }),
  })
}

export async function fetchPrInfo(issueId: string): Promise<PrInfo> {
  const res = await fetch(`${BASE}/pr?issueId=${encodeURIComponent(issueId)}`)
  return res.json()
}

export interface PrCreatePreview {
  ok: boolean
  error?: string
  title?: string
  body?: string
  bodySource?: 'skill' | 'generated' | 'fallback'
  repo?: string
  baseBranch?: string
  branch?: string
  linkRef?: string
  commitCount?: number
}

export async function fetchPrCreatePreview(issueId: string): Promise<PrCreatePreview> {
  const res = await fetch(`${BASE}/pr/preview-create?issueId=${encodeURIComponent(issueId)}`)
  return res.json()
}

export async function prAction(
  issueId: string,
  action: 'push' | 'create' | 'merge' | 'approve' | 'ready',
  overrides?: { title?: string; body?: string; baseBranch?: string },
): Promise<{ ok: boolean; output: string }> {
  const res = await fetch(`${BASE}/pr/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueId, ...(overrides || {}) }),
  })
  return res.json()
}
