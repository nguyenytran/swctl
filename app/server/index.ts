import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { readAllInstances } from './lib/metadata.js'
import { getContainerStatuses } from './lib/docker.js'
import { readProjects, readProjectConfig, addProjectEntry, removeProjectEntry } from './lib/projects.js'
import { listWorkflows } from './lib/workflows.js'
import { streamSwctl, spawnSwctl, isStreamActive, cancelStream, streamCommand } from './lib/stream.js'
import { listBranches, listGitWorktrees, discoverToolWorktrees, discoverPluginWorktrees } from './lib/git.js'
import {
  fetchGitHubIssues,
  isDeviceFlowConfigured,
  requestDeviceCode,
  pollDeviceAuth,
  fetchGitHubUser,
  resolveUsername,
} from './lib/github.js'

const app = new Hono()

// Resolve GitHub token: cookie → env var → token file (written by `swctl auth login`)
function resolveGitHubToken(cookieToken?: string): { token: string; source: string } {
  if (cookieToken) return { token: cookieToken, source: 'cookie' }
  // Read token file on disk (written by `swctl auth login`, mounted via SWCTL_STATE_DIR volume)
  const stateDir = process.env.SWCTL_STATE_DIR || ''
  if (stateDir) {
    const tokenFile = path.join(stateDir, 'github.token')
    try {
      const t = fs.readFileSync(tokenFile, 'utf-8').trim()
      if (t) return { token: t, source: 'cli' }
    } catch {}
  }
  return { token: '', source: '' }
}

// --- API routes ---

app.get('/api/instances', async (c) => {
  const [instances, statuses, projects] = await Promise.all([
    readAllInstances(),
    getContainerStatuses(),
    Promise.resolve(readProjects()),
  ])

  // Read checkout state to annotate checked-out instance
  let checkoutIssueId = ''
  try {
    const stateDir = process.env.SWCTL_STATE_DIR || path.join(process.env.HOME || '/root', '.local/state/swctl')
    const checkoutContent = fs.readFileSync(path.join(stateDir, 'checkout.state'), 'utf-8')
    const m = checkoutContent.match(/CHECKOUT_ACTIVE_ISSUE=(?:'([^']*)'|"([^"]*)"|(\S+))/)
    checkoutIssueId = m?.[1] || m?.[2] || m?.[3] || ''
  } catch {}

  // Enrich managed instances with Docker container status
  for (const inst of instances) {
    inst.kind = 'managed'
    if (checkoutIssueId && inst.issueId === checkoutIssueId) {
      inst.checkedOut = true
    }
    const cs = statuses[inst.composeProject]
    if (cs) {
      inst.containerStatus = cs.state === 'running' ? 'running' : 'exited'
      inst.containerInfo = cs.status
    } else {
      inst.containerStatus = 'missing'
      inst.containerInfo = ''
    }
  }

  // Discover external worktrees via git (Claude Code, Codex, manual)
  const managedPaths = new Set(instances.map((i: any) => i.worktreePath).filter(Boolean))

  // 1. From registered projects (git worktree list)
  const registeredPaths = new Set(projects.map((p: { path: string }) => p.path))
  const registeredSlugs = new Map(projects.map((p: { path: string; name: string }) => [p.path, p.name]))
  const gitWtArrays = await Promise.all(
    projects.map(p => listGitWorktrees(p.path, p.name))
  )
  const fromRegistered = gitWtArrays.flat().filter(wt => !managedPaths.has(wt.worktreePath))

  // 2. From plugin repos under registered platforms (git worktree list)
  // Filter out plugin worktrees nested inside managed instance worktree paths
  // (e.g., _worktrees/sw-14540/custom/plugins/X is part of managed sw-14540)
  const managedPathsArr = [...managedPaths]
  const isInsideManaged = (wtPath: string) =>
    managedPaths.has(wtPath) || managedPathsArr.some(mp => wtPath.startsWith(mp + '/'))
  const fromPlugins = await discoverPluginWorktrees(projects)
  const pluginFiltered = fromPlugins.filter(wt => !isInsideManaged(wt.worktreePath))

  // 3. From tool directories (~/.codex/worktrees/, ~/.claude/worktrees/)
  const allDiscoveredPaths = new Set([
    ...fromRegistered.map(wt => wt.worktreePath),
    ...pluginFiltered.map(wt => wt.worktreePath),
  ])
  const fromTools = await discoverToolWorktrees(registeredPaths, registeredSlugs)
  const toolFiltered = fromTools.filter(wt =>
    !managedPaths.has(wt.worktreePath) && !allDiscoveredPaths.has(wt.worktreePath)
  )

  return c.json([...instances, ...fromRegistered, ...pluginFiltered, ...toolFiltered])
})

app.get('/api/config', (c) => {
  return c.json(readProjectConfig())
})

app.get('/api/projects', (c) => {
  return c.json(readProjects())
})

app.post('/api/projects', async (c) => {
  const body = await c.req.json<{
    name: string
    path: string
    type: string
    parent?: string
    pluginDir?: string
  }>()
  const result = addProjectEntry(body)
  return c.json(result, result.ok ? 200 : 400)
})

app.delete('/api/projects/:name', (c) => {
  const name = c.req.param('name')
  const result = removeProjectEntry(name)
  return c.json(result, result.ok ? 200 : 400)
})

app.get('/api/workflows', (c) => {
  return c.json(listWorkflows())
})

app.post('/api/projects/init', async (c) => {
  const result = await spawnSwctl(['project', 'init'])
  if (!result.ok) return c.json({ ok: false, projects: [] })
  return c.json({ ok: true, projects: readProjects() })
})

app.post('/api/projects/init-config', async (c) => {
  const body = await c.req.json<{
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
    workflow: string
  }>()

  if (!body.path || !body.name) {
    return c.json({ ok: false, error: 'Path and name are required' }, 400)
  }

  const confPath = path.join(body.path, '.swctl.conf')
  if (fs.existsSync(confPath)) {
    return c.json({ ok: false, error: '.swctl.conf already exists' }, 400)
  }

  const slug = body.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const networkName = body.shareNetwork || `${path.basename(body.path)}_default`
  const baseBranch = body.baseBranch || 'trunk'

  // Detect composer root version from Kernel.php on the base branch
  let composerRootVersion = '6.7.9999999-dev' // fallback
  try {
    const kernelSrc = execSync(
      `git -C "${body.path}" show "${baseBranch}:src/Core/Kernel.php" 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000 },
    )
    const match = kernelSrc.match(/SHOPWARE_FALLBACK_VERSION\s*=\s*'([^']+)'/)
    if (match) composerRootVersion = match[1]
  } catch {}

  const workflow = body.workflow || 'shopware6'

  const conf = `# swctl config for ${body.name}
SWCTL_WORKFLOW="${workflow}"
SW_PROJECT="${slug}"
SW_BASE_BRANCH="${baseBranch}"
SW_DOMAIN_SUFFIX="${slug}.localhost"

SW_WORKTREE_ROOT="../_worktrees"
SW_WORKTREE_PREFIX="${slug}"

SW_PHP_IMAGE="${body.phpImage || 'ghcr.io/shopware/docker-dev:php8.4-node24-caddy'}"
SW_DOCKER_PLATFORM=""

SW_COMPOSER_ROOT_VERSION="${composerRootVersion}"

SW_PROJECT_NETWORK="${networkName}"

SW_DB_HOST="${body.dbHost || 'database'}"
SW_DB_PORT="${body.dbPort || '3306'}"
SW_DB_ROOT_USER="${body.dbRootUser || 'root'}"
SW_DB_ROOT_PASSWORD="${body.dbRootPassword || 'root'}"
SW_DB_NAME_PREFIX="${body.dbNamePrefix || slug}"
SW_DB_SHARED_NAME="${body.dbSharedName || slug + '_shared'}"
SW_REDIS_URL="redis://valkey:6379"
SW_MAILER_DSN="smtp://mailer:1025"
SW_OPENSEARCH_URL="http://opensearch:9200"
SW_BIN_CONSOLE="bin/console"
SW_APP_HTTP_PORT="8000"
SW_ENV_FILE_NAME=".env.local"

SW_INSTALL_ARGS="--basic-setup --force --no-interaction"
SW_SHARED_DB_INSTALL_ARGS="--basic-setup --force --no-interaction"
`

  try {
    fs.writeFileSync(confPath, conf, 'utf8')
  } catch (err: any) {
    return c.json({ ok: false, error: `Failed to write config: ${err.message}` }, 500)
  }

  // Register the project
  const result = addProjectEntry({
    name: slug,
    path: body.path,
    type: 'platform',
    workflow,
  })

  if (!result.ok) {
    return c.json({ ok: false, error: result.error })
  }

  return c.json({ ok: true, name: slug })
})

app.get('/api/browse', async (c) => {
  // Browse root: SWCTL_BROWSE_ROOT > parent of PROJECT_ROOT > HOME > /
  const browseRoot = path.resolve(
    process.env.SWCTL_BROWSE_ROOT
    || (process.env.PROJECT_ROOT ? path.dirname(process.env.PROJECT_ROOT) : '')
    || process.env.HOME
    || '/'
  )
  let reqPath = c.req.query('path') || browseRoot

  // Clamp: never navigate above browse root
  const resolved = path.resolve(reqPath)
  if (!resolved.startsWith(browseRoot)) {
    reqPath = browseRoot
  }

  try {
    const stat = fs.statSync(reqPath)
    if (!stat.isDirectory()) return c.json({ error: 'Not a directory' }, 400)
  } catch {
    return c.json({ error: 'Path not found' }, 400)
  }

  const current = path.resolve(reqPath)
  const parent = path.dirname(current)
  const isRoot = current === browseRoot
  const hasSwctlConf = fs.existsSync(path.join(current, '.swctl.conf'))
  const hasGit = fs.existsSync(path.join(current, '.git'))

  // Read .swctl.conf to get project name if it exists
  let projectName = ''
  if (hasSwctlConf) {
    try {
      const conf = fs.readFileSync(path.join(current, '.swctl.conf'), 'utf8')
      const match = conf.match(/^SW_PROJECT=["']?([^"'\n]+)/m)
      if (match) projectName = match[1]
    } catch {}
  }

  // Detect base branch from git
  let baseBranch = ''
  if (hasGit) {
    try {
      const headRef = fs.readFileSync(path.join(current, '.git', 'HEAD'), 'utf8').trim()
      const match = headRef.match(/ref: refs\/heads\/(.+)/)
      if (match) baseBranch = match[1]
    } catch {}
  }

  let dirs: { name: string; path: string; hasSwctlConf: boolean; hasGit: boolean }[] = []
  try {
    const entries = fs.readdirSync(current, { withFileTypes: true })
    dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'vendor')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => {
        const fullPath = path.join(current, e.name)
        return {
          name: e.name,
          path: fullPath,
          hasSwctlConf: fs.existsSync(path.join(fullPath, '.swctl.conf')),
          hasGit: fs.existsSync(path.join(fullPath, '.git')),
        }
      })
  } catch {}

  return c.json({ current, parent, dirs, hasSwctlConf, hasGit, projectName, baseBranch, isRoot })
})

app.get('/api/plugins', async (c) => {
  const projectName = c.req.query('project') || ''
  if (!projectName) return c.json([])
  const result = await spawnSwctl(['project', 'plugins', projectName])
  if (!result.ok) return c.json([])
  const plugins = result.output.split('\n').filter(Boolean)
  return c.json(plugins)
})

app.get('/api/branches', async (c) => {
  const projectName = c.req.query('project') || ''
  const plugin = c.req.query('plugin') || ''
  const query = c.req.query('q') || ''
  if (!projectName) return c.json([])
  const projects = readProjects()
  const project = projects.find((p: { name: string }) => p.name === projectName)
  if (!project) return c.json([])
  // If a plugin is specified, use the plugin's git repo for branch listing
  const repoPath = plugin ? `${project.path}/custom/plugins/${plugin}` : project.path
  const branches = await listBranches(repoPath, query || undefined)
  return c.json(branches)
})

app.post('/api/instances/:issueId/exec', async (c) => {
  const issueId = c.req.param('issueId')
  const { command } = await c.req.json<{ command: string }>()
  if (!command) return c.json({ error: 'Missing command' }, 400)
  const result = await spawnSwctl(['exec', issueId, command])
  return c.json({ ok: result.ok, output: result.output })
})

// --- Settings & IDE ---

app.get('/api/settings', (c) => {
  const editor = process.env.SWCTL_EDITOR || 'code'
  // IDE URL schemes — browser navigates to these, host OS opens the IDE
  const editorSchemes: Record<string, { name: string; urlTemplate: string }> = {
    phpstorm: { name: 'PhpStorm', urlTemplate: 'jetbrains://phpstorm/navigate/reference?path={path}' },
    code:     { name: 'VS Code',  urlTemplate: 'vscode://file/{path}' },
    cursor:   { name: 'Cursor',   urlTemplate: 'cursor://file/{path}' },
    zed:      { name: 'Zed',      urlTemplate: 'zed://file/{path}' },
    idea:     { name: 'IntelliJ', urlTemplate: 'jetbrains://idea/navigate/reference?path={path}' },
    webstorm: { name: 'WebStorm', urlTemplate: 'jetbrains://web-storm/navigate/reference?path={path}' },
  }
  const scheme = editorSchemes[editor]
  return c.json({
    editor,
    editorName: scheme?.name || editor,
    editorUrl: scheme?.urlTemplate || `vscode://file/{path}`,
  })
})

// --- GitHub integration (Device Flow) ---

// Check auth status
app.get('/api/github/status', async (c) => {
  const { token, source: tokenSource } = resolveGitHubToken(getCookie(c, 'gh_token'))

  if (!token) {
    return c.json({
      authenticated: false,
      deviceFlowConfigured: isDeviceFlowConfigured(),
    })
  }

  const user = await fetchGitHubUser(token)
  if (!user) {
    if (tokenSource === 'cookie') deleteCookie(c, 'gh_token')
    return c.json({ authenticated: false, deviceFlowConfigured: isDeviceFlowConfigured() })
  }

  return c.json({
    authenticated: true,
    deviceFlowConfigured: isDeviceFlowConfigured(),
    tokenSource,
    user,
  })
})

// Device Flow step 1: request device code
app.post('/api/github/device-code', async (c) => {
  if (!isDeviceFlowConfigured()) {
    return c.json({ error: 'GitHub OAuth not configured. Set SWCTL_GITHUB_CLIENT_ID.' }, 400)
  }
  const result = await requestDeviceCode()
  return c.json(result)
})

// Device Flow step 2: poll for authorization
app.post('/api/github/device-poll', async (c) => {
  const body = await c.req.json() as { device_code: string }
  if (!body.device_code) return c.json({ status: 'error', error: 'Missing device_code' }, 400)

  const result = await pollDeviceAuth(body.device_code)

  if (result.status === 'authorized' && result.access_token) {
    setCookie(c, 'gh_token', result.access_token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30, // 30 days
    })
  }

  return c.json({ status: result.status, error: result.error })
})

// Logout
app.post('/api/github/logout', (c) => {
  deleteCookie(c, 'gh_token', { path: '/' })
  return c.json({ ok: true })
})

// Fetch issues/PRs relevant to the authenticated user
app.get('/api/github/issues', async (c) => {
  // Read org from query param, or fall back to config, or default 'shopware'
  const org = c.req.query('org') || readProjectConfig()['SWCTL_GITHUB_ORG'] || 'shopware'

  const { token } = resolveGitHubToken(getCookie(c, 'gh_token'))
  if (!token) {
    return c.json({ items: [], error: 'auth_required' })
  }

  const username = await resolveUsername(token)
  if (!username) {
    return c.json({ items: [], error: 'auth_required' })
  }

  const result = await fetchGitHubIssues(org, username, token)
  return c.json(result)
})

// --- Streaming endpoints ---

app.get('/api/stream/create', (c) => {
  const issue = c.req.query('issue') || ''
  const mode = c.req.query('mode') || 'dev'
  let branch = c.req.query('branch') || ''
  const project = c.req.query('project') || ''
  const plugin = c.req.query('plugin') || ''
  const deps = c.req.query('deps') || ''
  const adoptWorktreePath = c.req.query('adoptWorktreePath') || ''

  if (!issue) return c.json({ error: 'Missing issue parameter' }, 400)

  // In dev mode, swctl prompts interactively for branch name if not provided.
  // Since we run non-interactively (no TTY in container), auto-generate a branch name.
  // When adopting an external worktree, the branch is inferred from the worktree itself.
  if (mode === 'dev' && !branch && !adoptWorktreePath) {
    branch = `feature/${issue}`
  }

  const args = ['create']
  if (project) args.push('--project', project)
  if (plugin) args.push('--plugin', plugin)
  if (deps) args.push('--deps', deps)
  if (adoptWorktreePath) args.push('--adopt-worktree', adoptWorktreePath)
  if (mode === 'qa') args.push('--qa')
  if (branch) args.push(issue, branch)
  else args.push(issue)

  return streamSwctl(c, args, `create:${issue}`)
})

app.get('/api/stream/clean', (c) => {
  const issueId = c.req.query('issueId') || ''
  const force = c.req.query('force') === '1'
  if (!issueId) return c.json({ error: 'Missing issueId parameter' }, 400)

  const args = ['clean', issueId]
  if (force) args.push('--force')
  return streamSwctl(c, args, `clean:${issueId}`)
})

app.get('/api/stream/refresh', (c) => {
  const issueId = c.req.query('issueId') || ''
  if (!issueId) return c.json({ error: 'Missing issueId parameter' }, 400)
  // Cancel any previous create/refresh streams for this issue
  cancelStream(`create:${issueId}`)
  cancelStream(`refresh:${issueId}`)
  return streamSwctl(c, ['refresh', issueId], `refresh:${issueId}`)
})

app.get('/api/stream/switch-mode', (c) => {
  const issueId = c.req.query('issueId') || ''
  const mode = c.req.query('mode') || ''
  if (!issueId || !mode) return c.json({ error: 'Missing parameters' }, 400)
  return streamSwctl(c, ['switch', issueId, `--${mode}`], `switch:${issueId}`)
})

app.get('/api/stream/checkout', (c) => {
  const issueId = c.req.query('issueId') || ''
  if (!issueId) return c.json({ error: 'Missing issueId parameter' }, 400)
  return streamSwctl(c, ['checkout', issueId], `checkout:${issueId}`)
})

app.get('/api/stream/checkout-return', (c) => {
  return streamSwctl(c, ['checkout', '--return'], 'checkout:return')
})

app.get('/api/checkout-state', (c) => {
  const stateDir = process.env.SWCTL_STATE_DIR || path.join(process.env.HOME || '/root', '.local/state/swctl')
  const stateFile = path.join(stateDir, 'checkout.state')
  try {
    const content = fs.readFileSync(stateFile, 'utf-8')
    const issueMatch = content.match(/CHECKOUT_ACTIVE_ISSUE=(?:'([^']*)'|"([^"]*)"|(\S+))/)
    const branchMatch = content.match(/CHECKOUT_PREVIOUS_BRANCH=(?:'([^']*)'|"([^"]*)"|(\S+))/)
    return c.json({
      active: true,
      issueId: issueMatch?.[1] || issueMatch?.[2] || issueMatch?.[3] || '',
      previousBranch: branchMatch?.[1] || branchMatch?.[2] || branchMatch?.[3] || '',
    })
  } catch {
    return c.json({ active: false, issueId: '', previousBranch: '' })
  }
})

app.post('/api/instances/:issueId/restart', async (c) => {
  const issueId = c.req.param('issueId')
  const result = await spawnSwctl(['restart', issueId])
  return c.json({ ok: result.ok })
})

app.post('/api/instances/:issueId/stop', async (c) => {
  const issueId = c.req.param('issueId')
  const result = await spawnSwctl(['stop', issueId])
  return c.json({ ok: result.ok })
})

app.post('/api/instances/:issueId/start', async (c) => {
  const issueId = c.req.param('issueId')
  const result = await spawnSwctl(['start', issueId])
  return c.json({ ok: result.ok })
})

app.get('/api/stream/logs', (c) => {
  const issueId = c.req.query('issueId') || ''
  if (!issueId) return c.json({ error: 'Missing issueId' }, 400)
  cancelStream(`logs:${issueId}`)
  return streamSwctl(c, ['logs', issueId, '--follow'], `logs:${issueId}`)
})

app.get('/api/stream/exec', (c) => {
  const issueId = c.req.query('issueId') || ''
  const command = c.req.query('command') || ''
  if (!issueId || !command) return c.json({ error: 'Missing issueId or command' }, 400)
  cancelStream(`exec:${issueId}`)
  return streamSwctl(c, ['exec', issueId, command], `exec:${issueId}`, () => {
    // Kill the process inside the container when the stream is aborted
    spawnSwctl(['kill-exec', issueId]).catch(() => {})
  })
})

app.post('/api/instances/:issueId/kill-exec', async (c) => {
  const issueId = c.req.param('issueId')
  cancelStream(`exec:${issueId}`)
  const result = await spawnSwctl(['kill-exec', issueId])
  return c.json({ ok: result.ok })
})

// Worktree terminal — runs commands directly in the worktree directory (not inside Docker container)
app.get('/api/stream/worktree-exec', async (c) => {
  const issueId = c.req.query('issueId') || ''
  const command = c.req.query('command') || ''
  if (!issueId || !command) return c.json({ error: 'Missing issueId or command' }, 400)

  const instances = await readAllInstances()
  const inst = instances.find((i: { issueId: string }) => i.issueId === issueId)
  if (!inst?.worktreePath) return c.json({ error: 'Instance not found or no worktree path' }, 404)

  cancelStream(`worktree-exec:${issueId}`)
  return streamCommand(c, inst.worktreePath, command, `worktree-exec:${issueId}`)
})

app.post('/api/instances/:issueId/kill-worktree-exec', async (c) => {
  const issueId = c.req.param('issueId')
  const cancelled = cancelStream(`worktree-exec:${issueId}`)
  return c.json({ ok: cancelled })
})

// Git diff for worktree (dev mode) — returns stat summary + unified diff
app.get('/api/diff', async (c) => {
  const issueId = c.req.query('issueId') || ''
  if (!issueId) return c.json({ error: 'Missing issueId' }, 400)

  const instances = await readAllInstances()
  const inst = instances.find((i: { issueId: string }) => i.issueId === issueId)
  if (!inst?.worktreePath) return c.json({ error: 'Instance not found' }, 404)

  // For plugin-external instances, diff the plugin repo (not the trunk platform).
  let diffCwd = inst.worktreePath
  let baseRef = inst.baseRef || 'HEAD~1'
  const branch = inst.branch || 'HEAD'

  if (inst.projectType === 'plugin-external' && inst.pluginName) {
    const pluginDir = path.join(inst.worktreePath, 'custom', 'plugins', inst.pluginName)
    if (fs.existsSync(pluginDir)) {
      diffCwd = pluginDir
      // Resolve the plugin repo's default branch as the base ref
      try {
        const defaultBranch = execSync(
          'git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed "s@^refs/remotes/@@" || echo origin/main',
          { cwd: pluginDir, encoding: 'utf-8', timeout: 5000 },
        ).trim()
        baseRef = defaultBranch || 'origin/main'
      } catch {
        baseRef = 'origin/main'
      }
    }
  }

  // Try HEAD first, then origin/$BRANCH as fallback.
  // HEAD may equal baseRef if the worktree was created before the
  // remote-tracking fix — in that case origin/$BRANCH has the real changes.
  let ref = 'HEAD'
  try {
    const stat = execSync(`git diff --stat "${baseRef}...HEAD"`, { cwd: diffCwd, encoding: 'utf-8', timeout: 10000 }).trim()
    if (!stat && branch && branch !== 'HEAD') {
      // HEAD has no changes vs base — check if origin/branch has them
      const remoteStat = execSync(`git diff --stat "${baseRef}...origin/${branch}"`, { cwd: diffCwd, encoding: 'utf-8', timeout: 10000 }).trim()
      if (remoteStat) ref = `origin/${branch}`
    }
  } catch {}

  let stat = '', diff = ''
  try {
    stat = execSync(`git diff --stat "${baseRef}...${ref}"`, { cwd: diffCwd, encoding: 'utf-8', timeout: 10000 })
  } catch {}
  try {
    diff = execSync(`git diff "${baseRef}...${ref}"`, { cwd: diffCwd, encoding: 'utf-8', timeout: 30000 })
  } catch {}

  return c.json({ stat, diff, ref })
})

app.get('/api/stream/status', (c) => {
  const id = c.req.query('id') || ''
  return c.json({ active: isStreamActive(id) })
})

app.post('/api/stream/cancel', (c) => {
  const id = c.req.query('id') || ''
  if (!id) return c.json({ error: 'Missing id parameter' }, 400)
  const cancelled = cancelStream(id)
  return c.json({ ok: cancelled })
})

// --- Instance setup (for linked external worktrees) ---

app.post('/api/instances/:issueId/setup', async (c) => {
  const issueId = c.req.param('issueId')
  const stateDir = process.env.SWCTL_STATE_DIR || path.join(process.env.HOME || '/root', '.local/state/swctl')
  const instancesDir = path.join(stateDir, 'instances')

  // Find the metadata file across all project dirs
  let metaFile = ''
  if (fs.existsSync(instancesDir)) {
    for (const project of fs.readdirSync(instancesDir)) {
      const candidate = path.join(instancesDir, project, `${issueId}.env`)
      if (fs.existsSync(candidate)) {
        metaFile = candidate
        break
      }
    }
  }

  if (!metaFile) {
    return c.json({ ok: false, error: `Instance "${issueId}" not found` }, 404)
  }

  // Set STATUS=creating so swctl refresh will do full provisioning
  try {
    let content = fs.readFileSync(metaFile, 'utf8')
    content = content.replace(/^STATUS="[^"]*"/m, 'STATUS="creating"')
    fs.writeFileSync(metaFile, content, 'utf8')
  } catch (err: any) {
    return c.json({ ok: false, error: `Failed to update metadata: ${err.message}` }, 500)
  }

  return c.json({ ok: true })
})

// --- External worktree management ---

app.post('/api/external-worktrees/link', async (c) => {
  const body = await c.req.json<{
    worktreePath: string
    issueId: string
    project: string
  }>()

  if (!body.worktreePath || !body.issueId || !body.project) {
    return c.json({ ok: false, error: 'Missing required fields: worktreePath, issueId, project' }, 400)
  }

  const stateDir = process.env.SWCTL_STATE_DIR || path.join(process.env.HOME || '/root', '.local/state/swctl')
  const projectDir = path.join(stateDir, 'instances', body.project)
  const envFile = path.join(projectDir, `${body.issueId}.env`)

  // Check for conflicts
  if (fs.existsSync(envFile)) {
    return c.json({ ok: false, error: `Instance "${body.issueId}" already exists in project "${body.project}"` }, 409)
  }

  // Verify worktree path exists
  if (!fs.existsSync(body.worktreePath)) {
    return c.json({ ok: false, error: `Worktree path not found: ${body.worktreePath}` }, 400)
  }

  // Get branch from git
  const { execSync } = await import('child_process')
  let branch = ''
  try {
    branch = execSync(`git -C "${body.worktreePath}" rev-parse --abbrev-ref HEAD`, {
      timeout: 5000,
      encoding: 'utf8',
    }).trim()
    if (branch === 'HEAD') branch = '' // detached
  } catch {}

  // Read project config
  const projects = readProjects()
  const proj = projects.find(p => p.name === body.project)
  const projectRoot = proj?.path || ''
  const slug = body.project
  const issueId = body.issueId.toLowerCase().replace(/[^a-z0-9-]/g, '-')

  // Read .swctl.conf to get base branch, domain suffix, db prefix, etc.
  let baseBranch = 'trunk'
  let confPath = ''
  if (projectRoot) {
    confPath = path.join(projectRoot, '.swctl.conf')
    try {
      const conf = fs.readFileSync(confPath, 'utf8')
      const m = conf.match(/^SW_BASE_BRANCH=["']?([^"'\n]+)/m)
      if (m) baseBranch = m[1]
    } catch {}
  }

  // Compute COMPOSE_PROJECT the same way swctl does: sanitize_slug("${slug}-${issueId}")
  const composeProject = `${slug}-${issueId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')

  // Detect OrbStack vs standard Docker — check if orbctl exists (same heuristic as swctl)
  let isOrbstack = false
  try {
    execSync('command -v orbctl', { timeout: 2000, stdio: 'pipe' })
    isOrbstack = true
  } catch {}

  const domain = isOrbstack
    ? `web.${composeProject}.orb.local`
    : `${slug}-${issueId}.localhost`
  const appUrl = `http://${domain}`

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')

  // Write metadata compatible with swctl's write_metadata format
  const envContent = `SWCTL_META_VERSION=2
ISSUE="${body.issueId}"
ISSUE_ID="${issueId}"
PROJECT="${slug}"
PROJECT_SLUG="${slug}"
PROJECT_ROOT="${projectRoot}"
CONFIG_PATH="${confPath}"
BRANCH="${branch}"
BASE_REF="${baseBranch}"
WORKTREE_PATH="${body.worktreePath}"
WORKTREE_ID="${issueId}"
DOMAIN=""
APP_URL=""
DB_NAME=""
DB_STATE=""
COMPOSE_PROJECT="${composeProject}"
COMPOSE_ENV_FILE=""
COMPOSE_TEMPLATE=""
COMPOSE_VOLUME_OVERRIDE=""
VENDOR_VOLUME=""
NODE_MODULES_VOLUME=""
MIGRATION_CHANGES=0
ENTITY_CHANGES=0
ADMIN_CHANGES=0
STOREFRONT_CHANGES=0
COMPOSER_CHANGES=0
PACKAGE_CHANGES=0
BACKEND_CHANGES=0
FRONTEND_CHANGES=0
SWCTL_MODE=dev
PROJECT_TYPE="${proj?.type || 'platform'}"
PLUGIN_NAME=""
LINKED_PLUGINS=""
PLUGIN_WORKTREE_PATHS=""
PLATFORM_WORKTREE_PATH=""
PLATFORM_ISSUE_ID=""
STATUS="complete"
FAILED_AT=""
CREATED_AT="${now}"
`

  try {
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(envFile, envContent, 'utf8')
  } catch (err: any) {
    return c.json({ ok: false, error: `Failed to write metadata: ${err.message}` }, 500)
  }

  return c.json({ ok: true })
})

app.get('/api/stream/refresh-external', async (c) => {
  const worktreePath = c.req.query('worktreePath') || ''
  const project = c.req.query('project') || ''

  if (!worktreePath || !project) {
    return c.json({ error: 'Missing worktreePath or project parameter' }, 400)
  }

  if (!fs.existsSync(worktreePath)) {
    return c.json({ error: `Worktree path not found: ${worktreePath}` }, 404)
  }

  // Find the project's base branch from .swctl.conf
  const projects = readProjects()
  const proj = projects.find(p => p.name === project)
  let baseBranch = 'trunk'
  if (proj?.path) {
    try {
      const confPath = path.join(proj.path, '.swctl.conf')
      if (fs.existsSync(confPath)) {
        const conf = fs.readFileSync(confPath, 'utf8')
        const match = conf.match(/^SW_BASE_BRANCH=["']?([^"'\n]+)/m)
        if (match) baseBranch = match[1]
      }
    } catch {}
  }

  const streamId = `refresh-ext:${worktreePath}`
  cancelStream(streamId)

  const command = [
    'set -e',
    `echo "Refreshing external worktree: ${path.basename(worktreePath)}"`,
    `echo "Base branch: ${baseBranch}"`,
    'echo ""',
    'echo "==> git fetch origin"',
    'git fetch origin',
    'echo ""',
    `echo "==> git rebase origin/${baseBranch}"`,
    `git rebase origin/${baseBranch}`,
    'echo ""',
    'echo "Done."',
  ].join(' && ')

  return streamCommand(c, worktreePath, command, streamId)
})

// --- Static files (production: serve built Vue app) ---

app.use('/*', serveStatic({ root: './dist' }))
app.use('/*', serveStatic({ root: './dist', path: '/index.html' }))

// --- Start ---

const port = parseInt(process.env.PORT || '3000', 10)
serve({ fetch: app.fetch, port }, () => {
  console.log(`swctl-ui server listening on http://localhost:${port}`)
})
