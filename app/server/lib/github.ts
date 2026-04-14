export interface LinkedPR {
  number: number
  branch: string
  title: string
  state: string  // 'open' | 'draft' | 'closed' | 'merged'
}

export interface LinkedIssue {
  number: number
  title: string
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
  repo?: string
  issueType?: string | null
  linkedPRs?: LinkedPR[]
  linkedIssues?: LinkedIssue[]
}

export interface GitHubResult {
  items: GitHubItem[]
  rateLimit?: { remaining: number; limit: number; reset: number }
  error?: string
}

export interface GitHubUser {
  login: string
  avatar_url: string
  name: string | null
}

// --- Device Flow auth (fallback when gh CLI not available) ---

const GITHUB_CLIENT_ID = process.env.SWCTL_GITHUB_CLIENT_ID || ''

export function isDeviceFlowConfigured(): boolean {
  return !!GITHUB_CLIENT_ID
}

export function getClientId(): string {
  return GITHUB_CLIENT_ID
}

export async function requestDeviceCode(): Promise<{
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
} | { error: string }> {
  try {
    const res = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        scope: 'repo read:org',
      }),
    })
    const data = await res.json() as any
    if (data.error) return { error: `${data.error}: ${data.error_description || ''}` }
    return data
  } catch (err: any) {
    return { error: `Request failed: ${err.message}` }
  }
}

export async function pollDeviceAuth(deviceCode: string): Promise<{
  status: 'authorized' | 'pending' | 'slow_down' | 'expired' | 'error'
  access_token?: string
  error?: string
}> {
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })
    const data = await res.json() as any

    if (data.access_token) {
      return { status: 'authorized', access_token: data.access_token }
    }
    if (data.error === 'authorization_pending') {
      return { status: 'pending' }
    }
    if (data.error === 'slow_down') {
      return { status: 'slow_down' }
    }
    if (data.error === 'expired_token') {
      return { status: 'expired' }
    }
    return { status: 'error', error: data.error_description || data.error || 'Unknown error' }
  } catch (err: any) {
    return { status: 'error', error: err.message }
  }
}

// --- User info ---

export async function fetchGitHubUser(token: string): Promise<GitHubUser | null> {
  try {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'swctl-ui',
      },
      body: JSON.stringify({ query: '{ viewer { login avatarUrl name } }' }),
    })
    if (!res.ok) return null
    const data = await res.json() as any
    const viewer = data?.data?.viewer
    if (!viewer) return null
    return { login: viewer.login, avatar_url: viewer.avatarUrl, name: viewer.name }
  } catch {
    return null
  }
}

// --- Username cache (avoids /user call on every issue fetch) ---

const usernameCache = new Map<string, { login: string; expiry: number }>()
const CACHE_TTL = 10 * 60 * 1000 // 10 minutes

export async function resolveUsername(token: string): Promise<string | null> {
  const cached = usernameCache.get(token)
  if (cached && cached.expiry > Date.now()) {
    return cached.login
  }
  const user = await fetchGitHubUser(token)
  if (!user) return null
  usernameCache.set(token, { login: user.login, expiry: Date.now() + CACHE_TTL })
  return user.login
}

// --- GraphQL helpers ---

function graphqlRequest(token: string, query: string, variables?: Record<string, any>): Promise<Response> {
  return fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'swctl-ui',
      'GraphQL-Features': 'issue_types',  // Required for issueType field
    },
    body: JSON.stringify({ query, variables }),
  })
}

function extractGraphQLRateLimit(data: any): { remaining: number; limit: number; reset: number } | undefined {
  const rl = data?.data?.rateLimit
  if (!rl) return undefined
  return {
    remaining: rl.remaining,
    limit: rl.limit,
    reset: Math.floor(new Date(rl.resetAt).getTime() / 1000),
  }
}

// --- Linked PR extraction from timeline items ---

function extractLinkedPRs(timelineNodes: any[]): LinkedPR[] {
  const stateOrder: Record<string, number> = { open: 0, draft: 1, closed: 2, merged: 3 }
  const prs: LinkedPR[] = []
  const seen = new Set<number>()

  for (const node of timelineNodes) {
    let pr: any = null
    if (node.__typename === 'CrossReferencedEvent') {
      pr = node.source
    } else if (node.__typename === 'ConnectedEvent') {
      pr = node.subject
    }

    if (!pr?.number || !pr?.headRefName) continue
    if (seen.has(pr.number)) continue
    seen.add(pr.number)

    let state = pr.state?.toLowerCase() || 'open'
    if (state === 'open' && pr.isDraft) state = 'draft'

    prs.push({
      number: pr.number,
      branch: pr.headRefName,
      title: pr.title || '',
      state,
    })
  }

  // Sort: open > draft > closed/merged
  prs.sort((a, b) => (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9))
  return prs
}

// --- Main: fetch issues + PRs via org-wide GraphQL search ---

const ISSUE_FRAGMENT = `
  ... on Issue {
    number title url state
    repository { nameWithOwner }
    author { login }
    labels(first: 5) { nodes { name color } }
    issueType { name }
    timelineItems(first: 20, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
      nodes {
        __typename
        ... on CrossReferencedEvent {
          source { ... on PullRequest { number title state isDraft headRefName } }
        }
        ... on ConnectedEvent {
          subject { ... on PullRequest { number title state isDraft headRefName } }
        }
      }
    }
  }
`

const PR_FRAGMENT = `
  ... on PullRequest {
    number title url state isDraft headRefName
    repository { nameWithOwner }
    author { login }
    labels(first: 5) { nodes { name color } }
    closingIssuesReferences(first: 5) { nodes { number title } }
  }
`

const GRAPHQL_ORG_SEARCH_QUERY = `
query ($assignedQ: String!, $reviewQ: String!, $authorQ: String!, $perPage: Int!) {
  assigned: search(query: $assignedQ, type: ISSUE, first: $perPage) {
    nodes { ${ISSUE_FRAGMENT} ${PR_FRAGMENT} }
  }
  reviewRequested: search(query: $reviewQ, type: ISSUE, first: $perPage) {
    nodes { ${PR_FRAGMENT} }
  }
  myPRs: search(query: $authorQ, type: ISSUE, first: $perPage) {
    nodes { ${PR_FRAGMENT} }
  }
  rateLimit { remaining limit resetAt }
}
`

export async function fetchGitHubIssues(
  org: string,
  username: string,
  token: string,
  perPage = 50,
): Promise<GitHubResult> {
  if (!org) {
    return { items: [], error: 'No GitHub organization configured.' }
  }

  try {
    const res = await graphqlRequest(token, GRAPHQL_ORG_SEARCH_QUERY, {
      assignedQ: `org:${org} is:open assignee:${username} sort:updated-desc`,
      reviewQ: `org:${org} is:open is:pr review-requested:${username} sort:updated-desc`,
      authorQ: `org:${org} is:open is:pr author:${username} sort:updated-desc`,
      perPage,
    })

    const body = await res.json() as any

    if (!res.ok) {
      const msg = body?.message || `HTTP ${res.status}`
      if (res.status === 401) return { items: [], error: 'auth_required' }
      return { items: [], error: msg }
    }

    if (body?.errors?.length) {
      const errMsg = body.errors.map((e: any) => e.message).join('; ')
      if (errMsg.includes('401') || errMsg.includes('Bad credentials')) {
        return { items: [], error: 'auth_required' }
      }
      return { items: [], error: errMsg }
    }

    const data = body?.data
    if (!data) {
      return { items: [], error: 'Unexpected response from GitHub' }
    }

    const rateLimit = extractGraphQLRateLimit(body)
    const items: GitHubItem[] = []
    // Deduplicate by repo+number (same item can appear in multiple search results)
    const seen = new Set<string>()
    const key = (node: any) => `${node.repository?.nameWithOwner}#${node.number}`

    // --- Assigned issues/PRs ---
    for (const node of data.assigned?.nodes || []) {
      if (!node?.number) continue
      const k = key(node)
      if (seen.has(k)) continue
      seen.add(k)

      const isPR = !!node.headRefName || node.isDraft !== undefined
      const linkedPRs = !isPR ? extractLinkedPRs(node.timelineItems?.nodes || []) : []
      const linkedIssues: LinkedIssue[] = isPR
        ? (node.closingIssuesReferences?.nodes || []).filter((i: any) => i?.number).map((i: any) => ({ number: i.number, title: i.title || '' }))
        : []

      items.push({
        number: node.number,
        title: node.title,
        labels: (node.labels?.nodes || []).map((l: any) => ({ name: l.name, color: l.color })),
        user: node.author?.login || '',
        branch: isPR ? (node.headRefName || null) : (linkedPRs.length > 0 ? linkedPRs[0].branch : null),
        isPR,
        url: node.url,
        category: 'assigned',
        repo: node.repository?.nameWithOwner || '',
        issueType: node.issueType?.name || null,
        linkedPRs: linkedPRs.length > 0 ? linkedPRs : undefined,
        linkedIssues: linkedIssues.length > 0 ? linkedIssues : undefined,
      })
    }

    // --- Review-requested PRs ---
    for (const node of data.reviewRequested?.nodes || []) {
      if (!node?.number) continue
      const k = key(node)
      if (seen.has(k)) continue
      seen.add(k)

      const linkedIssues: LinkedIssue[] = (node.closingIssuesReferences?.nodes || [])
        .filter((i: any) => i?.number).map((i: any) => ({ number: i.number, title: i.title || '' }))

      items.push({
        number: node.number,
        title: node.title,
        labels: (node.labels?.nodes || []).map((l: any) => ({ name: l.name, color: l.color })),
        user: node.author?.login || '',
        branch: node.headRefName || null,
        isPR: true,
        url: node.url,
        category: 'review-requested',
        repo: node.repository?.nameWithOwner || '',
        linkedIssues: linkedIssues.length > 0 ? linkedIssues : undefined,
      })
    }

    // --- My PRs ---
    for (const node of data.myPRs?.nodes || []) {
      if (!node?.number) continue
      const k = key(node)
      if (seen.has(k)) continue
      seen.add(k)

      const linkedIssues: LinkedIssue[] = (node.closingIssuesReferences?.nodes || [])
        .filter((i: any) => i?.number).map((i: any) => ({ number: i.number, title: i.title || '' }))

      items.push({
        number: node.number,
        title: node.title,
        labels: (node.labels?.nodes || []).map((l: any) => ({ name: l.name, color: l.color })),
        user: node.author?.login || '',
        branch: node.headRefName || null,
        isPR: true,
        url: node.url,
        category: 'my-pr',
        repo: node.repository?.nameWithOwner || '',
        linkedIssues: linkedIssues.length > 0 ? linkedIssues : undefined,
      })
    }

    // Sort: review-requested first, then my-pr, then assigned, within each group by number desc
    const categoryOrder = { 'review-requested': 0, 'my-pr': 1, 'assigned': 2 }
    items.sort((a, b) => {
      const catDiff = categoryOrder[a.category] - categoryOrder[b.category]
      if (catDiff !== 0) return catDiff
      return b.number - a.number
    })

    return { items, rateLimit }
  } catch (err: any) {
    return { items: [], error: `Network error: ${err.message}` }
  }
}
