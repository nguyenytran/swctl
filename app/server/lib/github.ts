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

// --- Main: fetch issues + PRs via single GraphQL query ---

const GRAPHQL_ISSUES_QUERY = `
query ($owner: String!, $name: String!, $username: String!, $perPage: Int!) {
  repository(owner: $owner, name: $name) {
    # Issues assigned to user
    assignedIssues: issues(
      first: $perPage
      filterBy: { assignee: $username, states: OPEN }
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes {
        number
        title
        url
        state
        author { login avatarUrl }
        labels(first: 5) { nodes { name color } }
        issueType { name }
        timelineItems(first: 20, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
          nodes {
            __typename
            ... on CrossReferencedEvent {
              source {
                ... on PullRequest { number title state isDraft headRefName }
              }
            }
            ... on ConnectedEvent {
              subject {
                ... on PullRequest { number title state isDraft headRefName }
              }
            }
          }
        }
      }
    }
    # Open PRs (filter by author + reviewer client-side)
    openPRs: pullRequests(
      first: $perPage
      states: OPEN
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes {
        number
        title
        url
        state
        isDraft
        headRefName
        author { login avatarUrl }
        labels(first: 5) { nodes { name color } }
        reviewRequests(first: 10) {
          nodes {
            requestedReviewer {
              ... on User { login }
              ... on Team { name }
            }
          }
        }
      }
    }
  }
  rateLimit { remaining limit resetAt }
}
`

export async function fetchGitHubIssues(
  repo: string,
  username: string,
  token: string,
  _state = 'open',
  perPage = 50,
): Promise<GitHubResult> {
  const [owner, name] = repo.split('/')
  if (!owner || !name) {
    return { items: [], error: 'Invalid repo format. Use owner/repo.' }
  }

  try {
    const res = await graphqlRequest(token, GRAPHQL_ISSUES_QUERY, {
      owner, name, username, perPage,
    })

    const body = await res.json() as any

    if (!res.ok) {
      const msg = body?.message || `HTTP ${res.status}`
      if (res.status === 401) return { items: [], error: 'auth_required' }
      return { items: [], error: msg }
    }

    if (body?.errors?.length) {
      const errMsg = body.errors.map((e: any) => e.message).join('; ')
      // Check for auth errors in GraphQL response
      if (errMsg.includes('401') || errMsg.includes('Bad credentials')) {
        return { items: [], error: 'auth_required' }
      }
      return { items: [], error: errMsg }
    }

    const repoData = body?.data?.repository
    if (!repoData) {
      return { items: [], error: `Repository '${repo}' not found or no access` }
    }

    const rateLimit = extractGraphQLRateLimit(body)
    const items: GitHubItem[] = []
    const seen = new Set<number>()

    // --- Process assigned issues ---
    for (const issue of repoData.assignedIssues?.nodes || []) {
      if (!issue || seen.has(issue.number)) continue
      seen.add(issue.number)

      const linkedPRs = extractLinkedPRs(issue.timelineItems?.nodes || [])

      items.push({
        number: issue.number,
        title: issue.title,
        labels: (issue.labels?.nodes || []).map((l: any) => ({ name: l.name, color: l.color })),
        user: issue.author?.login || '',
        branch: linkedPRs.length > 0 ? linkedPRs[0].branch : null,
        isPR: false,
        url: issue.url,
        category: 'assigned',
        issueType: issue.issueType?.name || null,
        linkedPRs: linkedPRs.length > 0 ? linkedPRs : undefined,
      })
    }

    // --- Process PRs (review-requested + my-pr) ---
    for (const pr of repoData.openPRs?.nodes || []) {
      if (!pr || seen.has(pr.number)) continue

      const isAuthor = pr.author?.login === username
      const isReviewer = (pr.reviewRequests?.nodes || []).some(
        (rr: any) => rr.requestedReviewer?.login === username,
      )

      if (!isAuthor && !isReviewer) continue
      seen.add(pr.number)

      const category = isReviewer ? 'review-requested' as const : 'my-pr' as const

      items.push({
        number: pr.number,
        title: pr.title,
        labels: (pr.labels?.nodes || []).map((l: any) => ({ name: l.name, color: l.color })),
        user: pr.author?.login || '',
        branch: pr.headRefName || null,
        isPR: true,
        url: pr.url,
        category,
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
