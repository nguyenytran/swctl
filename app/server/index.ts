import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { compress } from 'hono/compress'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import { execSync } from 'child_process'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { readAllInstances } from './lib/metadata.js'
import { computeCleanupState, computeCleanupStateBatch } from './lib/worktree-state.js'
import { getContainerStatuses } from './lib/docker.js'
import { readProjects, readProjectConfig, addProjectEntry, removeProjectEntry } from './lib/projects.js'
import { listWorkflows } from './lib/workflows.js'
import { streamSwctl, spawnSwctl, isStreamActive, cancelStream, streamCommand } from './lib/stream.js'
import { subscribe } from './lib/events.js'
import { cacheGet, installCacheInvalidators } from './lib/cache.js'
import { listBranches, listGitWorktrees, discoverToolWorktrees, discoverPluginWorktrees } from './lib/git.js'
import {
  fetchGitHubIssues,
  DEFAULT_ISSUE_LABEL_FILTERS,
  isDeviceFlowConfigured,
  requestDeviceCode,
  pollDeviceAuth,
  fetchGitHubUser,
  resolveUsername,
} from './lib/github.js'
import { listPlugins, resolvePluginFile, mimeForFile } from './lib/plugins.js'
import { startResolveStream, startResolveResumeStream, listResolveRuns, finishResolveRun, askResolveStream, getPrForIssue, getPrsForIssues, prAction, previewPrCreate } from './lib/resolve.js'
import { parseTranscript } from './lib/transcript.js'
import {
  readUserConfig,
  writeUserConfig,
  configFilePath,
  isResolveEnabled,
  validateAiConfig,
  resolveEnabledBackends,
  resolveDefaultBackend,
  testSkillInstall,
  KNOWN_BACKENDS,
  type KnownBackend,
} from './lib/config.js'
import { spawn as childSpawn } from 'child_process'

const app = new Hono()

// Wire event → cache-tag invalidation once at boot.  Keep this BEFORE any
// route definitions so the listeners are in place when requests arrive.
installCacheInvalidators()

// gzip/brotli every response big enough to benefit.  This single line
// takes the main JS bundle from 113 KB to ~43 KB on the wire, and
// similar ~60% reductions on /api/instances / /api/github/issues.
// `encoding: 'gzip'` covers every browser; Hono auto-skips already
// compressed content-types (images, fonts) and small responses.
app.use('*', compress({ encoding: 'gzip' }))

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

// Global SSE event stream — dashboard subscribes for real-time notifications
app.get('/api/events', (c) => {
  return streamSSE(c, async (stream) => {
    const unsubscribe = subscribe((event) => {
      try {
        stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
      } catch {}
    })

    // Keep connection alive with periodic pings
    const pingInterval = setInterval(() => {
      try { stream.writeSSE({ event: 'ping', data: '{}' }) } catch {}
    }, 30000)

    stream.onAbort(() => {
      unsubscribe()
      clearInterval(pingInterval)
    })

    // Hold the stream open indefinitely
    await new Promise<void>((resolve) => {
      stream.onAbort(resolve)
    })
  })
})

app.get('/api/instances', cacheGet({ ttlMs: 5_000, tag: 'instances' }), async (c) => {
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

// --- Pre-flight validation ---
app.get('/api/preflight', async (c) => {
  const issue = c.req.query('issue') || ''
  const project = c.req.query('project') || ''
  const branch = c.req.query('branch') || ''
  const mode = c.req.query('mode') || 'dev'

  const errors: string[] = []
  const warnings: string[] = []

  if (!issue) {
    errors.push('Issue ID is required')
    return c.json({ ok: false, errors, warnings })
  }

  // Check if issue already has an instance
  try {
    const instances = await readAllInstances()
    const existing = instances.find((i: any) => i.issueId === issue)
    if (existing) {
      errors.push(`Instance #${issue} already exists (${existing.branch})`)
    }
  } catch {}

  // Check if branch already exists in repo
  if (branch && project) {
    try {
      const projects = readProjects()
      const proj = projects.find((p: any) => p.name === project)
      if (proj) {
        const result = execSync(
          `git -C "${proj.path}" rev-parse --verify "refs/heads/${branch}" 2>/dev/null`,
          { encoding: 'utf8', timeout: 5000 },
        ).trim()
        if (result) {
          warnings.push(`Branch '${branch}' already exists in ${project}`)
        }
      }
    } catch {
      // Branch doesn't exist — that's fine
    }
  }

  // Check Docker health
  try {
    const dockerStatus = execSync('docker info --format "{{.ContainersRunning}}"', {
      encoding: 'utf8',
      timeout: 5000,
    }).trim()
    if (dockerStatus === '') {
      warnings.push('Docker may not be running')
    }
  } catch {
    warnings.push('Docker is not available or not running')
  }

  // Check disk space (warn if < 5GB free)
  try {
    const stats = fs.statfsSync(process.env.PROJECT_ROOT || process.env.HOME || '/')
    const freeGB = (stats.bfree * stats.bsize) / (1024 * 1024 * 1024)
    if (freeGB < 5) {
      warnings.push(`Low disk space: ${freeGB.toFixed(1)}GB free`)
    }
  } catch {}

  return c.json({ ok: errors.length === 0, errors, warnings })
})

// --- System info (for smart concurrency) ---
// CPU count + total RAM are process-lifetime constants; free RAM shifts
// but nothing in the UI reacts to the delta.  Cache for 60 s so the
// batch-create modal loads without a fresh OS probe on every open.
app.get('/api/system-info', cacheGet({ ttlMs: 60_000, tag: 'system' }), (c) => {
  const cpuCores = os.cpus().length
  const freeMemoryGB = +(os.freemem() / (1024 * 1024 * 1024)).toFixed(1)
  const totalMemoryGB = +(os.totalmem() / (1024 * 1024 * 1024)).toFixed(1)
  const suggestedConcurrency = Math.min(Math.max(1, Math.floor(cpuCores / 2)), 4)
  return c.json({ cpuCores, freeMemoryGB, totalMemoryGB, suggestedConcurrency })
})

// --- Shared diff-gathering helper for preview-create and analyze-branch ---

interface BranchDiffResult {
  files: string[]
  baseBranch: string
  effectiveBranch: string
  diffCwd: string
}

function getBranchDiff(params: {
  issue: string; branch: string; project: string; mode: string; plugin: string
}): BranchDiffResult | { error: string } {
  const projects = readProjects()
  const proj = projects.find(p => p.name === params.project) || projects.find(p => p.type === 'platform')
  if (!proj) return { error: 'No project found' }

  // Read base branch from .swctl.conf
  let baseBranch = 'trunk'
  try {
    const confPath = path.join(proj.path, '.swctl.conf')
    const conf = fs.readFileSync(confPath, 'utf8')
    const m = conf.match(/SW_BASE_BRANCH="([^"]+)"/)
    if (m) baseBranch = m[1]
  } catch {}

  const effectiveBranch = params.branch || (params.mode === 'dev' ? `feature/${params.issue}` : params.branch)
  let diffCwd = proj.path
  let diffRef = effectiveBranch

  // For plugin-external, diff the plugin repo
  if (params.plugin && proj.type === 'platform') {
    const pluginProj = projects.find(p => p.name === params.plugin && p.parent === proj.name)
    if (pluginProj) {
      diffCwd = pluginProj.path
      try {
        const defaultBranch = execSync(
          'git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed "s@^refs/remotes/origin/@@"',
          { cwd: pluginProj.path, encoding: 'utf-8', timeout: 5000 },
        ).trim()
        baseBranch = defaultBranch || 'main'
      } catch { baseBranch = 'main' }
    }
  }

  // Get diff files — try remote branch first, fall back to local
  let diffFiles = ''
  let resolvedRef = ''
  for (const ref of [`origin/${diffRef}`, diffRef]) {
    try {
      diffFiles = execSync(
        `git diff --name-only "${baseBranch}...${ref}"`,
        { cwd: diffCwd, encoding: 'utf-8', timeout: 10000 },
      ).trim()
      if (diffFiles) { resolvedRef = ref; break }
    } catch {}
  }

  const files = diffFiles ? diffFiles.split('\n') : []
  return { files, baseBranch, effectiveBranch, diffCwd }
}

// --- Smart create preview: analyze branch diff to predict which steps are needed ---
app.get('/api/preview-create', (c) => {
  const issue = c.req.query('issue') || ''
  const branch = c.req.query('branch') || ''
  const project = c.req.query('project') || ''
  const mode = c.req.query('mode') || 'dev'
  const plugin = c.req.query('plugin') || ''

  if (!issue) return c.json({ error: 'Missing issue' }, 400)

  const diffResult = getBranchDiff({ issue, branch, project, mode, plugin })
  if ('error' in diffResult) return c.json({ error: diffResult.error }, 400)

  const { files, effectiveBranch } = diffResult
  const count = (pattern: RegExp) => files.filter(f => pattern.test(f)).length

  const changes = {
    migration: count(/(^|\/)Migrations?\//),
    entity: count(/(^|\/)Entity\//),
    admin: count(/Resources\/app\/administration\/.*\.(js|ts|vue|scss)$/),
    storefront: count(/(Resources\/app\/storefront\/.*\.(js|ts|vue|scss)$|\.twig$)/),
    composer: count(/(^|\/)composer\.(json|lock)$/),
    package: count(/(^\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/),
    backend: files.filter(f => /\.php$/.test(f) && !/(^|\/)Migrations?\//.test(f) && !/(^|\/)Entity\//.test(f)).length,
  }

  const isQa = mode === 'qa'
  const hasDependencyChanges = changes.migration + changes.entity + changes.composer > 0
  const hasPackageChanges = changes.migration + changes.entity + changes.package > 0

  // Build step plan
  interface Step {
    id: string
    label: string
    enabled: boolean
    reason: string
  }

  const steps: Step[] = [
    { id: 'worktree', label: 'Create git worktree', enabled: true, reason: 'Always required' },
    { id: 'sync', label: 'Sync build artifacts', enabled: true, reason: 'Copy baseline assets from trunk' },
    { id: 'containers', label: 'Start Docker containers', enabled: true, reason: 'Always required' },
    { id: 'database', label: 'Clone database', enabled: true, reason: 'Always required' },
    {
      id: 'composer',
      label: 'Composer install',
      enabled: !isQa && hasDependencyChanges,
      reason: isQa ? 'QA mode uses shared vendor' : hasDependencyChanges ? `${changes.composer} composer file(s) changed` : 'No composer changes — reuse shared vendor',
    },
    {
      id: 'npm',
      label: 'NPM install',
      enabled: !isQa && hasPackageChanges,
      reason: isQa ? 'QA mode uses shared node_modules' : hasPackageChanges ? `${changes.package} package file(s) changed` : 'No package changes — reuse shared node_modules',
    },
    {
      id: 'admin',
      label: 'Build admin JS',
      enabled: !isQa && changes.admin > 0,
      reason: isQa ? 'QA mode skips builds' : changes.admin > 0 ? `${changes.admin} admin file(s) changed` : 'No admin changes — use synced assets',
    },
    {
      id: 'storefront',
      label: 'Build storefront JS',
      enabled: !isQa && changes.storefront > 0,
      reason: isQa ? 'QA mode skips builds' : changes.storefront > 0 ? `${changes.storefront} storefront file(s) changed` : 'No storefront changes — use synced assets',
    },
    {
      id: 'migration',
      label: 'Run migrations',
      enabled: changes.migration > 0,
      reason: changes.migration > 0 ? `${changes.migration} migration file(s) detected` : 'No migrations',
    },
    {
      id: 'cache',
      label: 'Clear cache',
      enabled: changes.backend + changes.admin + changes.storefront + changes.composer + changes.package > 0,
      reason: changes.backend > 0 ? `${changes.backend} PHP file(s) changed` : 'Code changes detected',
    },
  ]

  // Estimate time saved
  const skipped = steps.filter(s => !s.enabled)
  const timeSaved = skipped.reduce((sum, s) => {
    const est: Record<string, number> = { composer: 30, npm: 20, admin: 60, storefront: 60, migration: 5, cache: 5 }
    return sum + (est[s.id] || 0)
  }, 0)

  return c.json({
    issue,
    branch: effectiveBranch,
    mode,
    totalFiles: files.length,
    changes,
    steps,
    skippedCount: skipped.length,
    estimatedTimeSaved: timeSaved > 0 ? `~${timeSaved}s` : null,
  })
})

app.get('/api/config', (c) => {
  return c.json(readProjectConfig())
})

// Feature flags exposed to the UI so nav + routes can conditionally render.
// Dynamic: reads env var OR ~/.swctl/config.json so flipping the flag
// from /#/config takes effect immediately without a server restart.
app.get('/api/features', (c) => {
  return c.json({
    resolveEnabled: isResolveEnabled(),
  })
})

// ── User config (~/.swctl/config.json) ────────────────────────────────────
//
// Read + mutate the JSON config file the CLI (`swctl config …`) also uses.
// NOTE: the path is `/api/user-config` and NOT `/api/config` — the latter
// was already claimed by the Shopware project config reader above
// (returns `.swctl.conf` values like SW_PROJECT).  A path collision
// means the second handler is never called, so this split is required.
//
// Intentionally NOT behind the resolve gate — /#/config is how the user
// turns the resolve feature ON in the first place, so gating it would be
// a footgun.  The server-side read is authoritative: the shell's `_ai_*`
// helpers do the same precedence (env > config > default) so a fix
// started from the CLI sees the same binary + config dir as one started
// from the UI.
app.get('/api/user-config', (c) => {
  const cfg = readUserConfig()
  return c.json({
    path: configFilePath(),
    config: cfg,
    // Resolved values that apply the back-compat defaults — clients can
    // skip duplicating the resolveEnabledBackends / resolveDefaultBackend
    // logic and just trust this projection.  Important for the resolve
    // plugin's dropdown filtering.
    resolved: {
      enabledBackends: resolveEnabledBackends(cfg),
      defaultBackend:  resolveDefaultBackend(cfg),
    },
  })
})

app.put('/api/user-config', async (c) => {
  try {
    const body = await c.req.json<{ config?: unknown }>()
    if (!body.config || typeof body.config !== 'object') {
      return c.json({ error: 'Missing or invalid config object' }, 400)
    }
    // Type-validate the shape before writing — reject junk.
    const incoming = body.config as {
      features?: { resolveEnabled?: unknown }
      ai?: {
        defaultBackend?: unknown
        enabledBackends?: unknown
        claude?: { bin?: unknown; configDir?: unknown }
        codex?:  { bin?: unknown; configDir?: unknown }
      }
    }

    // Build a Partial<UserConfig> containing ONLY the keys the client
    // explicitly sent with a valid value.  `writeUserConfig` merges this
    // over the current on-disk config, so any key not included here is
    // preserved as-is.
    //
    // This avoids a class of bug where the sanitizer would emit
    // `{ resolveEnabled: undefined }` or `{ bin: undefined }` when the
    // client sent nothing — that undefined then spread over the real
    // on-disk value, dropping it.  Symptom: "save backend change" also
    // silently disabled the resolve feature + wiped claude.bin.  See
    // config.test regression note.
    const toStr = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

    type Cleanable = Parameters<typeof writeUserConfig>[0]
    const clean: NonNullable<Cleanable> = {}

    if (incoming.features && typeof incoming.features === 'object') {
      if (typeof incoming.features.resolveEnabled === 'boolean') {
        clean.features = { resolveEnabled: incoming.features.resolveEnabled }
      }
    }

    if (incoming.ai && typeof incoming.ai === 'object') {
      const aiPartial: NonNullable<Cleanable>['ai'] = {}
      if (incoming.ai.defaultBackend === 'claude' || incoming.ai.defaultBackend === 'codex') {
        aiPartial.defaultBackend = incoming.ai.defaultBackend
      }
      // enabledBackends — accept ONLY a non-empty array of known
      // backends.  Junk (string, object, mixed types, unknown values)
      // is dropped here so it can't reach validateAiConfig + reject the
      // whole save.  An invalid-but-present value just preserves the
      // on-disk list, matching the rest of the PUT's "absent ⇒ keep"
      // semantics.
      if (Array.isArray(incoming.ai.enabledBackends)) {
        const filtered: ('claude' | 'codex')[] = []
        const seen = new Set<string>()
        for (const v of incoming.ai.enabledBackends) {
          if ((v === 'claude' || v === 'codex') && !seen.has(v)) {
            seen.add(v)
            filtered.push(v)
          }
        }
        if (filtered.length > 0) aiPartial.enabledBackends = filtered
      }
      if (incoming.ai.claude && typeof incoming.ai.claude === 'object') {
        const claudeBin = toStr(incoming.ai.claude.bin)
        const claudeDir = toStr(incoming.ai.claude.configDir)
        if (claudeBin !== undefined || claudeDir !== undefined) {
          aiPartial.claude = {}
          if (claudeBin !== undefined) aiPartial.claude.bin = claudeBin
          if (claudeDir !== undefined) aiPartial.claude.configDir = claudeDir
        }
      }
      if (incoming.ai.codex && typeof incoming.ai.codex === 'object') {
        const codexBin = toStr(incoming.ai.codex.bin)
        const codexDir = toStr(incoming.ai.codex.configDir)
        if (codexBin !== undefined || codexDir !== undefined) {
          aiPartial.codex = {}
          if (codexBin !== undefined) aiPartial.codex.bin = codexBin
          if (codexDir !== undefined) aiPartial.codex.configDir = codexDir
        }
      }
      if (Object.keys(aiPartial).length > 0) clean.ai = aiPartial
    }

    // Cross-field validation (default-must-be-enabled, non-empty list,
    // known backends).  Reject with 400 + actionable message rather
    // than silently dropping into a nonsensical config.
    const validationError = validateAiConfig(clean, readUserConfig())
    if (validationError) {
      return c.json({ error: validationError }, 400)
    }

    const saved = writeUserConfig(clean)
    return c.json({
      ok: true,
      path: configFilePath(),
      config: saved,
      // Echo the resolved values too so the UI can show the same
      // semantics the rest of the system uses (resolveEnabledBackends
      // applies the back-compat default, resolveDefaultBackend picks
      // first-enabled-when-default-is-disabled, etc.).
      resolved: {
        enabledBackends: resolveEnabledBackends(saved),
        defaultBackend:  resolveDefaultBackend(saved),
      },
    })
  } catch (err: any) {
    return c.json({ error: err?.message || 'Failed to save config' }, 500)
  }
})

// ── CLI smoke-test for a backend ──────────────────────────────────────
//
// Spawn `<bin> --version` with a hard 5s timeout.  Returns {ok, version|error}
// so the /#/config UI's "Test" button can tell the user, in one click,
// whether the binary it's about to spawn for resolves is actually on
// PATH inside the swctl-ui container.
//
// History: users repeatedly hit "spawn codex ENOENT" with no way to
// pre-flight check before kicking a real resolve.  This endpoint is
// the deliberate pre-flight.
app.get('/api/user-config/test-cli', async (c) => {
  const backend = c.req.query('backend') as KnownBackend | undefined
  if (!backend || !(KNOWN_BACKENDS as readonly string[]).includes(backend)) {
    return c.json({
      ok: false,
      error: `unknown backend "${backend ?? '(none)'}"; allowed: ${KNOWN_BACKENDS.join(', ')}`,
    }, 400)
  }

  // Resolve the configured binary path, falling back to the bare
  // command name (which lets PATH lookup happen inside spawn).  This
  // mirrors how the real spawn sites resolve binaries.
  const cfg = readUserConfig()
  const bin = (cfg.ai?.[backend]?.bin || backend).trim() || backend

  const result = await new Promise<{ ok: boolean; version?: string; error?: string; bin: string }>((resolve) => {
    let settled = false
    const settle = (r: { ok: boolean; version?: string; error?: string }) => {
      if (settled) return
      settled = true
      resolve({ ...r, bin })
    }

    let child: ReturnType<typeof childSpawn>
    try {
      child = childSpawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e: any) {
      settle({ ok: false, error: `spawn threw: ${e?.message || String(e)}` })
      return
    }

    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout?.on('data', (b: Buffer) => chunks.push(b))
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf-8') })

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      settle({ ok: false, error: 'timeout after 5000ms' })
    }, 5000)

    child.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      settle({
        ok: false,
        error: err.code === 'ENOENT'
          ? `binary not found in container PATH (looked for: ${bin})`
          : err.message || String(err),
      })
    })

    child.once('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(chunks).toString('utf-8').trim()
      // Some CLIs print version to stderr; fall back to that if stdout is empty.
      const version = stdout || stderr.trim() || '(no version output)'
      if (code === 0) {
        // Take just the first line — claude / codex both print one line.
        settle({ ok: true, version: version.split('\n')[0].slice(0, 200) })
      } else {
        settle({
          ok: false,
          error: `${bin} --version exited ${code}; stderr: ${stderr.slice(0, 200) || '(empty)'}`,
        })
      }
    })
  })

  return c.json(result)
})

// ── Skill install pre-flight check ────────────────────────────────────
//
// Sibling to /test-cli, but answers a different question: "is the
// shopware-resolve skill installed where the agent will look?"
//
//   claude → ~/.claude/skills/shopware-resolve/SKILL.md exists +
//            front-matter name matches.  Claude Code's slash-command
//            registry walks that tree at startup, so file presence ≡
//            slash-command discoverability.
//
//   codex  → ~/.codex/AGENTS.md exists, contains the swctl-managed
//            marker block, and the SKILL.md inside the block has
//            `name: shopware-resolve` front-matter.  Codex reads
//            AGENTS.md as ambient context every run, so block presence
//            ≡ skill availability to the agent.
//
// Static check only (no spawn).  Useful as a one-click pre-flight in
// the /#/config page so the user knows the skill will actually be
// found before spending a real resolve cycle on it.
app.get('/api/user-config/test-skill', (c) => {
  const backend = c.req.query('backend') as KnownBackend | undefined
  if (!backend || !(KNOWN_BACKENDS as readonly string[]).includes(backend)) {
    return c.json({
      ok: false,
      error: `unknown backend "${backend ?? '(none)'}"; allowed: ${KNOWN_BACKENDS.join(', ')}`,
    }, 400)
  }
  return c.json(testSkillInstall(backend))
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

// Batch cleanup state (disk size, last activity, dirty, ahead/behind, PR state)
// for the /worktrees page's cleanup-focused UI. Capped at CLEANUP_BATCH_LIMIT
// ids per call to cap the `du` cost.
app.get('/api/instances/cleanup-state', async (c) => {
  const csv = c.req.query('issues') || ''
  const ids = csv.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  if (ids.length === 0) return c.json({})
  const out = await computeCleanupStateBatch(ids)
  return c.json(out)
})

// Single-instance cleanup state — used for targeted refreshes.
app.get('/api/instances/:issueId/cleanup-state', async (c) => {
  const issueId = c.req.param('issueId')
  const state = await computeCleanupState(issueId)
  if (!state) return c.json({ error: 'not_found' }, 404)
  return c.json(state)
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

// Return the default label allowlist the UI initialises its chip filter with.
app.get('/api/github/labels/defaults', cacheGet({ ttlMs: 5 * 60_000, tag: 'labels' }), async (c) => {
  return c.json({ labels: DEFAULT_ISSUE_LABEL_FILTERS })
})

// Fetch issues/PRs relevant to the authenticated user.
// Cached per (org, labels) — GitHub is the slow dependency here (~2 s), and
// the 60 s TTL is well under any meaningful label/assignment churn.  Key
// includes the gh token cookie so two users sharing a process don't collide.
app.get(
  '/api/github/issues',
  cacheGet({
    ttlMs: 60_000,
    tag: 'github',
    keyFn: (c) => {
      const url = new URL(c.req.url)
      const token = getCookie(c, 'gh_token') || ''
      const tokenHash = token ? token.slice(0, 8) : 'notoken'
      return `GET ${url.pathname}?${url.searchParams.toString()}#${tokenHash}`
    },
  }),
  async (c) => {
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

  // Parse `labels` query string: comma-separated allowlist. Presence of the
  // param (even empty) opts into filtering; absence means "no filter" so
  // first-load callers that don't know about labels still see everything.
  const labelsRaw = c.req.query('labels')
  const labelFilter = labelsRaw === undefined
    ? undefined
    : labelsRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)

  const result = await fetchGitHubIssues(org, username, token, 50, labelFilter)
  return c.json(result)
})

// --- Streaming endpoints ---

function getSource(c: any): 'mcp' | 'ui' { return c.req.query('source') === 'mcp' ? 'mcp' : 'ui' }

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

  return streamSwctl(c, args, `create:${issue}`, undefined, getSource(c))
})

app.get('/api/stream/clean', (c) => {
  const issueId = c.req.query('issueId') || ''
  const force = c.req.query('force') === '1'
  if (!issueId) return c.json({ error: 'Missing issueId parameter' }, 400)

  const args = ['clean', issueId]
  if (force) args.push('--force')
  return streamSwctl(c, args, `clean:${issueId}`, undefined, getSource(c))
})

app.get('/api/stream/refresh', (c) => {
  const issueId = c.req.query('issueId') || ''
  if (!issueId) return c.json({ error: 'Missing issueId parameter' }, 400)
  // Cancel any previous create/refresh streams for this issue
  cancelStream(`create:${issueId}`)
  cancelStream(`refresh:${issueId}`)
  return streamSwctl(c, ['refresh', issueId], `refresh:${issueId}`, undefined, getSource(c))
})

app.get('/api/stream/switch-mode', (c) => {
  const issueId = c.req.query('issueId') || ''
  const mode = c.req.query('mode') || ''
  if (!issueId || !mode) return c.json({ error: 'Missing parameters' }, 400)
  return streamSwctl(c, ['switch', issueId, `--${mode}`], `switch:${issueId}`, undefined, getSource(c))
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

  // Return the cwd + baseRef so the UI can render accurate "no commits"
  // hints (the diff scope differs between platform and plugin-external
  // instances).
  return c.json({ stat, diff, ref, baseRef, cwd: diffCwd })
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

  // Set STATUS=creating so swctl refresh does full provisioning.
  //
  // swctl writes env values in mixed styles (`STATUS=complete` unquoted,
  // `FAILED_AT=''` empty-quoted, quoted when values need escaping).
  // Match any form — with or without surrounding single/double quotes —
  // and replace atomically (temp file + rename) so a concurrent reader
  // never sees a truncated file.
  try {
    let content = fs.readFileSync(metaFile, 'utf8')
    const re = /^STATUS=(?:'[^']*'|"[^"]*"|[^\r\n]*)$/m
    if (re.test(content)) {
      content = content.replace(re, 'STATUS=creating')
    } else {
      // No STATUS line at all — append one.
      content = content.replace(/\s*$/, '') + '\nSTATUS=creating\n'
    }
    const tmp = `${metaFile}.tmp.${process.pid}.${Date.now()}`
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, metaFile)
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

// --- shopware-resolve skill: spawn Claude Code and stream output ---

// Feature flag: the resolve workflow is hidden by default.  Enable via
// either of:
//   - SWCTL_RESOLVE_ENABLED=1 (env var, legacy)
//   - `{ "features": { "resolveEnabled": true } }` in ~/.swctl/config.json
//     (set via /#/config in the UI or `swctl config set features.resolveEnabled true`)
// The check is dynamic so flipping it via the UI takes effect on the
// next request without a server restart.
app.use('/api/skill/resolve/*', async (c, next) => {
  if (!isResolveEnabled()) {
    return c.json({ error: 'resolve feature is disabled' }, 404)
  }
  await next()
})

app.get('/api/skill/resolve/stream', (c) => {
  const issue = c.req.query('issue') || ''
  const project = c.req.query('project') || ''
  const mode = (c.req.query('mode') as 'qa' | 'dev') || 'dev'
  // Optional backend override.  Defaults to 'claude' when absent / unknown.
  // Persisted to the instance's RESOLVE_BACKEND so resume/ask pick it up
  // without the UI having to re-send it.
  const backend = c.req.query('backend') || ''
  if (!issue) return c.json({ error: 'Missing issue parameter' }, 400)
  return startResolveStream(c, { issue, project: project || undefined, mode, backend })
})

app.get('/api/skill/resolve/runs', (c) => {
  return c.json(listResolveRuns())
})

/**
 * Per-issue transcript view.  Reads the agent's CANONICAL session log
 * (Claude Code: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl;
 * Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl) and
 * normalises it into the same per-step shape regardless of backend.
 *
 * The session log is the source of truth — both agents already write
 * every event there.  Reading it (vs. maintaining our own parallel
 * file) means historical runs from before this feature shipped show
 * up automatically, with no migration step.
 *
 * No caching: a live run is still appending to its session log; the
 * UI may poll while the run is in flight.
 */
app.get('/api/skill/resolve/transcript', (c) => {
  const issueId = c.req.query('issueId') || ''
  if (!issueId) return c.json({ error: 'Missing issueId' }, 400)
  return c.json(parseTranscript(issueId))
})

// Resume a previously-interrupted resolve run for an issue, re-using
// the stored Claude session id.  Streams the continuation transcript.
app.get('/api/skill/resolve/resume/stream', (c) => {
  const issueId = c.req.query('issueId') || ''
  if (!issueId) return c.json({ error: 'Missing issueId parameter' }, 400)
  return startResolveResumeStream(c, { issueId })
})

app.post('/api/skill/resolve/finish', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { issue?: string; exitCode?: number }
  if (!body.issue) return c.json({ error: 'Missing issue' }, 400)
  finishResolveRun(body.issue, body.exitCode ?? 0)
  return c.json({ ok: true })
})

// Ask Claude a follow-up question for a resolve session (SSE stream)
app.get('/api/skill/resolve/ask', (c) => {
  const issueId = c.req.query('issueId') || ''
  const message = c.req.query('message') || ''
  if (!issueId || !message) return c.json({ error: 'Missing issueId or message' }, 400)
  return askResolveStream(c, { issueId, message })
})

// Get PR info for an issue.  Cached briefly on top of the per-repo pulls
// cache already inside resolve.ts — collapses repeated clicks on the same
// issue to a single resolve call.
app.get('/api/skill/resolve/pr', cacheGet({ ttlMs: 10_000, tag: 'pr' }), async (c) => {
  const issueId = c.req.query('issueId') || ''
  if (!issueId) return c.json({ error: 'Missing issueId' }, 400)
  const pr = await getPrForIssue(issueId)
  return c.json(pr || { notFound: true })
})

// Batched variant: accept `issueIds=a,b,c` and return `{a: pr|null, ...}`.
// Groups by target repo and issues one /pulls listing call per repo, so the
// resolve page's table paint collapses N round-trips into one.
//
// HTTP-layer cache (15 s) matches the resolve page's 15 s repaint timer —
// the second paint tick serves from here without even entering the batching
// logic.  Tagged `pr` so PR-mutating actions can flush it explicitly.
app.get('/api/skill/resolve/pr/batch', cacheGet({ ttlMs: 15_000, tag: 'pr' }), async (c) => {
  const raw = c.req.query('issueIds') || ''
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (!ids.length) return c.json({})
  return c.json(await getPrsForIssues(ids))
})

// PR create preview: returns the title/body/base/etc. the create flow WOULD use,
// without mutating anything.  Used by the UI's edit-before-create modal.
app.get('/api/skill/resolve/pr/preview-create', async (c) => {
  const issueId = c.req.query('issueId') || ''
  if (!issueId) return c.json({ ok: false, error: 'Missing issueId' }, 400)
  const preview = await previewPrCreate(issueId)
  return c.json(preview)
})

// PR actions: push, create, merge, approve, ready.
// For `create`, the body may include user-edited overrides from the preview modal.
app.post('/api/skill/resolve/pr/:action', async (c) => {
  const action = c.req.param('action') as 'push' | 'create' | 'merge' | 'approve' | 'ready'
  const body = await c.req.json().catch(() => ({})) as {
    issueId?: string
    title?: string
    body?: string
    baseBranch?: string
  }
  if (!body.issueId) return c.json({ error: 'Missing issueId' }, 400)
  if (!['push', 'create', 'merge', 'approve', 'ready'].includes(action)) {
    return c.json({ error: `Invalid action: ${action}` }, 400)
  }
  const overrides = action === 'create'
    ? { title: body.title, body: body.body, baseBranch: body.baseBranch }
    : undefined
  const result = await prAction(body.issueId, action as any, overrides)
  return c.json(result)
})

// --- Plugins: list manifests + serve static plugin assets ---

// List all plugin manifests from ~/.swctl/plugins/
app.get('/api/plugins/list', cacheGet({ ttlMs: 60_000, tag: 'plugins' }), (c) => {
  try {
    const manifests = listPlugins().map((m) => ({
      ...m,
      // URL the browser should import to load the plugin entry
      entryUrl: `/api/plugins/${m.id}/${m.entry.replace(/^\/+/, '')}`,
    }))
    return c.json(manifests)
  } catch (err: any) {
    return c.json({ error: err?.message || 'Failed to list plugins' }, 500)
  }
})

// Serve a file from a plugin directory (entry script, assets, etc.)
app.get('/api/plugins/:id/*', (c) => {
  const id = c.req.param('id')
  // Everything after /api/plugins/:id/ is the file path
  const prefix = `/api/plugins/${id}/`
  const reqPath = new URL(c.req.url).pathname
  const rel = reqPath.startsWith(prefix) ? reqPath.slice(prefix.length) : ''
  const abs = resolvePluginFile(id, rel)
  if (!abs) return c.notFound()

  const body = fs.readFileSync(abs)
  return new Response(body, {
    headers: {
      'Content-Type': mimeForFile(abs),
      'Cache-Control': 'no-cache',
    },
  })
})

// --- Static files (production: serve built Vue app) ---
//
// Cache policy:
//   - Hashed Vite assets under /assets/ → immutable, 1y — safe because
//     the filename changes whenever the content changes.
//   - index.html → no-store — so a fresh container build picks up the
//     new asset hashes on the NEXT browser reload, not "whenever the
//     user happens to clear their cache".  Without this, users who
//     restart the container still see the previous bundle because their
//     browser returned a stale index.html from heuristic caching.
app.use('/*', async (c, next) => {
  await next()
  const url = new URL(c.req.url)
  if (url.pathname.startsWith('/assets/')) {
    c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  } else if (url.pathname === '/' || url.pathname.endsWith('.html') || url.pathname === '/index.html') {
    c.res.headers.set('Cache-Control', 'no-store, must-revalidate')
  }
})

app.use('/*', serveStatic({ root: './dist' }))
app.use('/*', serveStatic({ root: './dist', path: '/index.html' }))

// --- Start ---

const port = parseInt(process.env.SWCTL_UI_PORT || '3000', 10)
serve({ fetch: app.fetch, port }, () => {
  console.log(`swctl-ui server listening on http://localhost:${port}`)
})
