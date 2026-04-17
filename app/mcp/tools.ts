const API_BASE = process.env.SWCTL_UI_URL || `http://localhost:${process.env.SWCTL_UI_PORT || '3000'}`

type ToolResult = { content: Array<{ type: 'text'; text: string }> } & { isError?: boolean }

function text(msg: string): ToolResult {
  return { content: [{ type: 'text', text: msg }] }
}

function error(msg: string): ToolResult {
  return { content: [{ type: 'text', text: msg }], isError: true }
}

// --- HTTP helpers ---

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`)
  return res.json()
}

async function apiPost(path: string, body?: any): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

// Consume an SSE stream endpoint, collect log lines, return when 'done' event fires
async function callStream(path: string): Promise<{ ok: boolean; output: string; exitCode: number }> {
  const separator = path.includes('?') ? '&' : '?'
  const url = `${API_BASE}${path}${separator}source=mcp`

  return new Promise((resolve) => {
    const lines: string[] = []
    let resolved = false

    // Use native EventSource-like parsing over fetch
    fetch(url).then(async (res) => {
      if (!res.ok || !res.body) {
        // Non-streaming response (e.g. 409 conflict)
        const body = await res.text()
        resolve({ ok: false, output: body, exitCode: 1 })
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() || ''

        for (const part of parts) {
          const eventMatch = part.match(/^event:\s*(.+)$/m)
          const dataMatch = part.match(/^data:\s*(.+)$/m)
          if (!eventMatch || !dataMatch) continue

          const event = eventMatch[1]
          try {
            const data = JSON.parse(dataMatch[1])
            if (event === 'log' && data.line) {
              lines.push(data.line)
            } else if (event === 'done') {
              resolved = true
              resolve({
                ok: (data.exitCode || 0) === 0,
                output: lines.join('\n'),
                exitCode: data.exitCode || 0,
              })
            } else if (event === 'error') {
              resolved = true
              resolve({ ok: false, output: data.message || 'Stream error', exitCode: 1 })
            }
          } catch {}
        }
      }

      if (!resolved) {
        resolve({ ok: lines.length > 0, output: lines.join('\n'), exitCode: 0 })
      }
    }).catch((err) => {
      resolve({ ok: false, output: `Connection error: ${err.message}`, exitCode: 1 })
    })
  })
}

// --- Tool implementations ---

export async function listInstances(args: { project?: string }): Promise<ToolResult> {
  try {
    const items = await apiGet('/api/instances')
    if (!Array.isArray(items)) return error('Unexpected response from server.')

    // Filter managed instances (not external worktrees)
    let instances = items.filter((i: any) => i.kind !== 'external')
    if (args.project) {
      instances = instances.filter((i: any) => i.project === args.project || i.projectSlug === args.project)
    }

    if (instances.length === 0) return text('No instances found.')

    const lines = instances.map((i: any) => {
      const status = i.containerStatus === 'running' ? 'running' : i.containerStatus === 'exited' ? 'stopped' : 'missing'
      const checkout = i.checkedOut ? ' [checked out]' : ''
      const changes = []
      if (i.changes?.migration > 0) changes.push(`migration:${i.changes.migration}`)
      if (i.changes?.admin > 0) changes.push(`admin:${i.changes.admin}`)
      if (i.changes?.storefront > 0) changes.push(`storefront:${i.changes.storefront}`)
      if (i.changes?.backend > 0) changes.push(`backend:${i.changes.backend}`)
      if (i.changes?.composer > 0) changes.push(`composer:${i.changes.composer}`)
      const changesStr = changes.length > 0 ? ` (${changes.join(', ')})` : ''
      return `- #${i.issueId} [${status}] ${i.branch} → ${i.domain || 'no domain'}${checkout}${changesStr} (${i.mode}, ${i.project})`
    })

    return text(`**${instances.length} instance(s):**\n${lines.join('\n')}`)
  } catch (err: any) {
    return error(`Failed to list instances: ${err.message}`)
  }
}

export async function createWorktree(args: {
  issue: string
  branch?: string
  project?: string
  mode?: string
  plugin?: string
  deps?: string
}): Promise<ToolResult> {
  const params = new URLSearchParams({ issue: args.issue, mode: args.mode || 'dev' })
  if (args.branch) params.set('branch', args.branch)
  if (args.project) params.set('project', args.project)
  if (args.plugin) params.set('plugin', args.plugin)
  if (args.deps) params.set('deps', args.deps)

  const result = await callStream(`/api/stream/create?${params}`)
  if (result.ok) {
    return text(`Worktree created successfully.\n\n${result.output}`)
  }
  return error(`Worktree creation failed.\n\n${result.output}`)
}

export async function viewDiff(args: { issueId: string; statOnly?: boolean }): Promise<ToolResult> {
  try {
    const data = await apiGet(`/api/diff?issueId=${encodeURIComponent(args.issueId)}`)
    if (data.error) return error(data.error)

    const stat = data.stat || ''
    if (args.statOnly) return text(stat || 'No changes detected.')

    const diff = data.diff || ''
    if (!stat && !diff) return text('No changes detected.')
    return text(`**Diff stat:**\n\`\`\`\n${stat}\`\`\`\n\n**Full diff:**\n\`\`\`diff\n${diff}\`\`\``)
  } catch (err: any) {
    return error(`Failed to get diff: ${err.message}`)
  }
}

export async function execCommand(args: { issueId: string; command: string }): Promise<ToolResult> {
  try {
    const data = await apiPost(`/api/instances/${encodeURIComponent(args.issueId)}/exec`, { command: args.command })
    if (data.ok) return text(data.output || '(no output)')
    return error(`Command failed:\n${data.output || data.error || 'Unknown error'}`)
  } catch (err: any) {
    return error(`Failed to execute command: ${err.message}`)
  }
}

export async function startStop(args: { issueId: string; action: string }): Promise<ToolResult> {
  const action = args.action
  if (!['start', 'stop', 'restart'].includes(action)) {
    return error(`Invalid action '${action}'. Use: start, stop, restart`)
  }
  try {
    const data = await apiPost(`/api/instances/${encodeURIComponent(args.issueId)}/${action}`)
    if (data.ok) {
      return text(`Instance ${args.issueId} ${action}ed successfully.`)
    }
    return error(`Failed to ${action} instance ${args.issueId}: ${data.error || 'Unknown error'}`)
  } catch (err: any) {
    return error(`Failed to ${action}: ${err.message}`)
  }
}

export async function clean(args: { issueId: string }): Promise<ToolResult> {
  const result = await callStream(`/api/stream/clean?issueId=${encodeURIComponent(args.issueId)}&force=1`)
  if (result.ok) {
    return text(`Instance ${args.issueId} cleaned successfully.\n${result.output}`)
  }
  return error(`Failed to clean instance ${args.issueId}:\n${result.output}`)
}

export async function refresh(args: { issueId: string }): Promise<ToolResult> {
  const result = await callStream(`/api/stream/refresh?issueId=${encodeURIComponent(args.issueId)}`)
  if (result.ok) {
    return text(`Instance ${args.issueId} refreshed successfully.\n${result.output}`)
  }
  return error(`Failed to refresh instance ${args.issueId}:\n${result.output}`)
}

/**
 * Complete provisioning (database clone, Docker container, Shopware install)
 * for an instance that was created with `--no-provision`.  Mechanically this
 * is the same as `refresh` (both resume provisioning when STATUS is
 * creating/failed/provisioning-deferred), but the semantic distinction helps
 * Claude pick the right tool: use `swctl_setup` after Step 4 review passes
 * in the resolve workflow.
 */
export async function setup(args: { issueId: string }): Promise<ToolResult> {
  const result = await callStream(`/api/stream/refresh?issueId=${encodeURIComponent(args.issueId)}`)
  if (result.ok) {
    return text(`Instance ${args.issueId} provisioned successfully (container + DB ready).\n${result.output}`)
  }
  return error(`Failed to provision instance ${args.issueId}:\n${result.output}`)
}

export async function smartCreate(args: {
  issue: string
  branch?: string
  project?: string
  mode?: string
  plugin?: string
  deps?: string
  context?: string
}): Promise<ToolResult> {
  const mode = args.mode || 'dev'
  const project = args.project || ''

  // Step 1: Run preflight checks
  const preflightParams = new URLSearchParams({ issue: args.issue })
  if (project) preflightParams.set('project', project)
  if (args.branch) preflightParams.set('branch', args.branch)
  preflightParams.set('mode', mode)

  let preflightResult: { ok: boolean; errors: string[]; warnings: string[] }
  try {
    preflightResult = await apiGet(`/api/preflight?${preflightParams}`)
  } catch (err: any) {
    return error(`Pre-flight check failed: ${err.message}`)
  }

  if (!preflightResult.ok) {
    return error(
      `Pre-flight validation failed for #${args.issue}:\n` +
      preflightResult.errors.map(e => `  - ${e}`).join('\n') +
      (preflightResult.warnings.length > 0
        ? '\n\nWarnings:\n' + preflightResult.warnings.map(w => `  - ${w}`).join('\n')
        : '')
    )
  }

  const warningNote = preflightResult.warnings.length > 0
    ? `\n\n**Warnings:**\n${preflightResult.warnings.map(w => `- ${w}`).join('\n')}`
    : ''

  // Step 2: Preview create — analyze branch diff to show what will happen
  let previewNote = ''
  try {
    const previewParams = new URLSearchParams({ issue: args.issue, mode })
    if (project) previewParams.set('project', project)
    if (args.branch) previewParams.set('branch', args.branch)
    if (args.plugin) previewParams.set('plugin', args.plugin)

    const preview = await apiGet(`/api/preview-create?${previewParams}`)
    if (preview.steps) {
      const enabled = preview.steps.filter((s: any) => s.enabled)
      const skipped = preview.steps.filter((s: any) => !s.enabled)
      const lines: string[] = []
      lines.push(`**Create plan** (${preview.totalFiles} files changed):`)
      for (const s of enabled) lines.push(`  - [run] ${s.label}: ${s.reason}`)
      for (const s of skipped) lines.push(`  - [skip] ${s.label}: ${s.reason}`)
      if (preview.estimatedTimeSaved) lines.push(`  Time saved: ${preview.estimatedTimeSaved}`)
      previewNote = '\n\n' + lines.join('\n')
    }
  } catch {
    // Preview is informational — don't block creation
  }

  // Step 3: Create the worktree
  const createResult = await createWorktree({
    issue: args.issue,
    branch: args.branch,
    project: args.project,
    mode,
    plugin: args.plugin,
    deps: args.deps,
  })

  if (createResult.isError) {
    return error(createResult.content[0].text + previewNote)
  }

  return text(
    createResult.content[0].text + warningNote + previewNote
  )
}

export async function githubIssues(args: { org?: string }): Promise<ToolResult> {
  try {
    const params = args.org ? `?org=${encodeURIComponent(args.org)}` : ''
    const [data, instancesRaw] = await Promise.all([
      apiGet(`/api/github/issues${params}`),
      apiGet('/api/instances').catch(() => []),
    ])

    // Build lookups for existing worktrees: by issue ID and by branch name
    const managedInstances = (Array.isArray(instancesRaw) ? instancesRaw : [])
      .filter((i: any) => i.kind !== 'external')
    const existingIds = new Set(managedInstances.map((i: any) => String(i.issueId)))
    const existingBranches = new Set(managedInstances.map((i: any) => i.branch).filter(Boolean))

    if (data.error) {
      if (data.error === 'auth_required') {
        return error('GitHub authentication required. Run `swctl auth login` first.')
      }
      return error(`GitHub API error: ${data.error}`)
    }

    const items = data.items || []
    if (items.length === 0) return text('No open issues or PRs found.')

    // Match by issue number, PR branch, or linked PR branch
    const hasWorktree = (i: any): boolean => {
      if (existingIds.has(String(i.number))) return true
      if (i.branch && existingBranches.has(i.branch)) return true
      if (i.linkedPRs?.length) {
        for (const pr of i.linkedPRs) {
          if (pr.branch && existingBranches.has(pr.branch)) return true
        }
      }
      return false
    }

    const categories: Record<string, any[]> = {
      'review-requested': [],
      'my-pr': [],
      'assigned': [],
    }
    for (const item of items) {
      categories[item.category]?.push(item)
    }

    // Filter out items that already have a worktree
    let hiddenCount = 0
    for (const key of Object.keys(categories)) {
      const before = categories[key].length
      categories[key] = categories[key].filter((i: any) => !hasWorktree(i))
      hiddenCount += before - categories[key].length
    }

    const formatItem = (i: any, isPR: boolean) => {
      if (isPR) {
        return `  - PR #${i.number}: ${i.title} (${i.repo}) [${i.branch || 'no branch'}]`
      }
      const type = i.isPR ? 'PR' : 'Issue'
      const linked = i.linkedPRs?.length ? ` → PR #${i.linkedPRs[0].number}` : ''
      return `  - ${type} #${i.number}: ${i.title} (${i.repo})${linked} [${i.branch || 'no branch'}]`
    }

    const sections: string[] = []

    if (categories['review-requested'].length > 0) {
      const lines = categories['review-requested'].map((i: any) => formatItem(i, true))
      sections.push(`**Review Requested (${lines.length}):**\n${lines.join('\n')}`)
    }

    if (categories['my-pr'].length > 0) {
      const lines = categories['my-pr'].map((i: any) => formatItem(i, true))
      sections.push(`**My PRs (${lines.length}):**\n${lines.join('\n')}`)
    }

    if (categories['assigned'].length > 0) {
      const lines = categories['assigned'].map((i: any) => formatItem(i, false))
      sections.push(`**Assigned (${lines.length}):**\n${lines.join('\n')}`)
    }

    const skipped = hiddenCount > 0 ? `\n\n_${hiddenCount} item(s) hidden (worktree already exists)_` : ''
    const rl = data.rateLimit
    const rateInfo = rl ? `\n_Rate limit: ${rl.remaining}/${rl.limit}_` : ''
    return text(sections.join('\n\n') + skipped + rateInfo)
  } catch (err: any) {
    return error(`Failed to fetch GitHub issues: ${err.message}`)
  }
}
