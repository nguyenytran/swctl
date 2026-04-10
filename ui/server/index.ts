import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import fs from 'fs'
import path from 'path'
import { readAllInstances } from './lib/metadata.js'
import { getContainerStatuses } from './lib/docker.js'
import { readProjects, readProjectConfig, addProjectEntry, removeProjectEntry } from './lib/projects.js'
import { streamSwctl, spawnSwctl, isStreamActive, cancelStream, streamCommand } from './lib/stream.js'
import { listBranches } from './lib/git.js'

const app = new Hono()

// --- API routes ---

app.get('/api/instances', async (c) => {
  const [instances, statuses] = await Promise.all([
    readAllInstances(),
    getContainerStatuses(),
  ])
  for (const inst of instances) {
    const cs = statuses[inst.composeProject]
    if (cs) {
      inst.containerStatus = cs.state === 'running' ? 'running' : 'exited'
      inst.containerInfo = cs.status
    } else {
      inst.containerStatus = 'missing'
      inst.containerInfo = ''
    }
  }
  return c.json(instances)
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

  const conf = `# swctl config for ${body.name}
SW_PROJECT="${slug}"
SW_BASE_BRANCH="${body.baseBranch || 'trunk'}"
SW_DOMAIN_SUFFIX="${slug}.localhost"

SW_WORKTREE_ROOT="../_worktrees"
SW_WORKTREE_PREFIX="${slug}"

SW_PHP_IMAGE="${body.phpImage || 'ghcr.io/shopware/docker-dev:php8.4-node24-caddy'}"
SW_DOCKER_PLATFORM=""

SW_COMPOSER_ROOT_VERSION="6.7.9999999-dev"

SW_TRUNK_NETWORK="${networkName}"

SW_DB_HOST="${body.dbHost || 'database'}"
SW_DB_PORT="${body.dbPort || '3306'}"
SW_DB_ROOT_USER="${body.dbRootUser || 'root'}"
SW_DB_ROOT_PASSWORD="${body.dbRootPassword || 'root'}"
SW_DB_NAME_PREFIX="${body.dbNamePrefix || slug}"
SW_DB_SHARED_NAME="${body.dbSharedName || 'shopware'}"
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

// --- Streaming endpoints ---

app.get('/api/stream/create', (c) => {
  const issue = c.req.query('issue') || ''
  const mode = c.req.query('mode') || 'dev'
  let branch = c.req.query('branch') || ''
  const project = c.req.query('project') || ''
  const plugin = c.req.query('plugin') || ''

  if (!issue) return c.json({ error: 'Missing issue parameter' }, 400)

  // In dev mode, swctl prompts interactively for branch name if not provided.
  // Since we run non-interactively (no TTY in container), auto-generate a branch name.
  if (mode === 'dev' && !branch) {
    branch = `feature/${issue}`
  }

  const args = ['create']
  if (project) args.push('--project', project)
  if (plugin) args.push('--plugin', plugin)
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

// --- Static files (production: serve built Vue app) ---

app.use('/*', serveStatic({ root: './dist' }))
app.use('/*', serveStatic({ root: './dist', path: '/index.html' }))

// --- Start ---

const port = parseInt(process.env.PORT || '3000', 10)
serve({ fetch: app.fetch, port }, () => {
  console.log(`swctl-ui server listening on http://localhost:${port}`)
})
