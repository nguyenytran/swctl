import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execSync } from 'child_process'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { spawn } from 'child_process'
import { streamSpawn, spawnSwctl } from './stream.js'
import { readAllInstances } from './metadata.js'
import { readProjects } from './projects.js'
import { emit } from './events.js'
import { isResolveEnabled } from './config.js'
import { detectScopeWithAI, type AiScopeDecision } from './ai-scope.js'

const STATE_DIR = process.env.SWCTL_STATE_DIR || ''
const RUNS_FILE = STATE_DIR ? path.join(STATE_DIR, 'resolve-runs.json') : ''

/**
 * Serialises `swctl create` spawns across all concurrent HTTP streams.
 *
 * Why: `swctl create` mutates shared state that doesn't lock well when
 * N creates run in parallel — plugin repo's `.git/{config,index}.lock`,
 * the MySQL source DB for TOCTOU-free clones, docker compose port
 * bindings, shared base volumes mid-population, and (indirectly)
 * OrbStack's VirtioFS bandwidth.  Previous behaviour: 3 of 5 batch
 * creates silently failed.  With this queue: 100% complete, slightly
 * slower overall, and user sees their queue position.
 *
 * Per-job callbacks receive the 0-indexed queue depth at the moment
 * their work actually starts, so the UI can render "queued (2 ahead)"
 * → "running".
 */
class CreateQueue {
  private queue: Array<() => Promise<void>> = []
  private running = 0

  /**
   * Maximum concurrent `swctl create` spawns.  Default 2 — two hides
   * wall-clock during the slow rsync phase of one create behind the
   * other's git-worktree / scope-detection work, while keeping peak
   * FD pressure and OrbStack VirtioFS load well below the thresholds
   * that silently broke the previous unbounded flow.  Override with
   * SWCTL_CREATE_PARALLEL=<N> (e.g. =1 for full serial, =4 for fast
   * hosts).
   */
  readonly maxConcurrent: number = Math.max(
    1,
    parseInt(process.env.SWCTL_CREATE_PARALLEL || '2', 10) || 2,
  )

  /** Total jobs in the system — queued + currently running. */
  depth(): number {
    return this.queue.length + this.running
  }

  /**
   * Enqueue `fn`.  Resolves with `fn`'s return value once it has
   * actually run.  `onEnqueue` fires synchronously with the number of
   * jobs ahead AT enqueue time; `onStart` fires when the job actually
   * begins running (slot claimed).
   */
  async run<T>(
    fn: () => Promise<T>,
    onEnqueue?: (aheadAtQueueTime: number) => void,
    onStart?: () => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const aheadAtQueueTime = this.depth()
      onEnqueue?.(aheadAtQueueTime)
      this.queue.push(async () => {
        onStart?.()
        try { resolve(await fn()) } catch (e) { reject(e) }
      })
      this.drain()
    })
  }

  private drain() {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift()!
      this.running++
      // Start the job; on settle, decrement and try to drain more.
      job()
        .catch(() => { /* per-job errors already reported to caller */ })
        .finally(() => {
          this.running--
          this.drain()
        })
    }
  }
}

/** Singleton — one per swctl-ui process. */
const createQueue = new CreateQueue()

export interface ResolveRun {
  issue: string
  project?: string
  mode?: string
  startedAt: string
  finishedAt?: string
  status: 'running' | 'done' | 'failed'
  exitCode?: number
}

function readRuns(): ResolveRun[] {
  if (!RUNS_FILE || !fs.existsSync(RUNS_FILE)) return []
  try {
    return JSON.parse(fs.readFileSync(RUNS_FILE, 'utf-8'))
  } catch {
    return []
  }
}

function writeRuns(runs: ResolveRun[]): void {
  if (!RUNS_FILE) return
  try {
    fs.mkdirSync(path.dirname(RUNS_FILE), { recursive: true })
    // Atomic: temp file + rename.  Without this, a second writer
    // truncating the file mid-JSON.parse() of a concurrent reader
    // yields garbage.  Renaming is atomic on the same FS on all
    // POSIX systems we target.
    const tmp = `${RUNS_FILE}.tmp.${process.pid}.${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(runs.slice(0, 20), null, 2))
    fs.renameSync(tmp, RUNS_FILE)
  } catch (err) {
    console.warn('[resolve] failed to write runs file:', err)
  }
}

// Serialises concurrent read-modify-write cycles on resolve-runs.json.
// Without this, two HTTP streams both call recordStart() at the same
// time: both read the same snapshot, both prepend their entry, the
// later write loses the earlier entry.
let _runsMutationChain: Promise<void> = Promise.resolve()
async function mutateRuns(fn: (runs: ResolveRun[]) => ResolveRun[]): Promise<void> {
  const next = _runsMutationChain.then(() => {
    const runs = readRuns()
    writeRuns(fn(runs))
  })
  _runsMutationChain = next.catch(() => {})
  return next
}

export function listResolveRuns(): ResolveRun[] {
  return readRuns()
}

function recordStart(run: Omit<ResolveRun, 'startedAt' | 'status'>): void {
  void mutateRuns(runs => {
    runs.unshift({ ...run, startedAt: new Date().toISOString(), status: 'running' })
    return runs
  })
}

function recordFinish(issue: string, exitCode: number): void {
  void mutateRuns(runs => {
    const idx = runs.findIndex(r => r.issue === issue && r.status === 'running')
    if (idx >= 0) {
      runs[idx] = {
        ...runs[idx],
        status: exitCode === 0 ? 'done' : 'failed',
        exitCode,
        finishedAt: new Date().toISOString(),
      }
    }
    return runs
  })
}

/**
 * Normalise a string to an alpha-numeric lowercase slug so plugin names
 * ("SwagCustomizedProducts"), extension labels ("Custom-Products") and
 * user input can all be compared loosely.
 */
function normSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Read the swctl GitHub token written by `swctl auth login` (same file used
 * by the Resolve form's issue picker). Returns the empty string if absent.
 */
function readSwctlGithubToken(): string {
  const stateDir = process.env.SWCTL_STATE_DIR || ''
  if (!stateDir) return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  try {
    const p = path.join(stateDir, 'github.token')
    return fs.readFileSync(p, 'utf-8').trim()
  } catch {
    return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  }
}

/**
 * Fetch an issue's labels directly from the GitHub REST API using swctl's
 * stored token. We avoid `gh` CLI here because its auth in the container
 * can drift out of sync with the host's; swctl's own token is already
 * maintained by the UI's auth flow.
 *
 * Returns an empty array on any failure so the caller can just fall through
 * to platform-scope defaults.
 */
async function fetchIssueLabels(issueRef: string): Promise<string[]> {
  const info = await fetchIssueInfo(issueRef)
  return info?.labels || []
}

/**
 * Fetch full issue info from GitHub: title + labels + html_url.  Used by
 * the PR-create flow to build a squashed commit message and to persist
 * the source repo in instance metadata.  Returns null on any failure.
 */
export async function fetchIssueInfo(issueRef: string): Promise<{
  owner: string; repo: string; number: string; title: string; body: string; labels: string[]; htmlUrl: string
} | null> {
  let owner = 'shopware', repo = 'shopware', num = ''
  const urlMatch = issueRef.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/)
  const refMatch = issueRef.match(/^([^/]+)\/([^/#]+)#(\d+)$/)
  const numMatch = issueRef.match(/^(\d+)$/)
  if (urlMatch) { owner = urlMatch[1]; repo = urlMatch[2]; num = urlMatch[3] }
  else if (refMatch) { owner = refMatch[1]; repo = refMatch[2]; num = refMatch[3] }
  else if (numMatch) { num = numMatch[1] }
  else return null

  const token = readSwctlGithubToken()
  if (!token) return null

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${num}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!res.ok) return null
    const data = await res.json() as { title?: string; body?: string; labels?: Array<{ name?: string }>; html_url?: string }
    return {
      owner, repo, number: num,
      title: data.title || '',
      // Additive: AI scope detection reads this.  Existing callers just
      // ignore the new field.
      body: data.body || '',
      labels: (data.labels || []).map((l) => l?.name || '').filter(Boolean),
      htmlUrl: data.html_url || `https://github.com/${owner}/${repo}/issues/${num}`,
    }
  } catch {
    return null
  }
}

/**
 * Split an extension label on non-alphanumerics and return the lowercase
 * words (length ≥ 3 to skip noise like "a", "of").
 */
function labelWords(label: string): string[] {
  return label.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3)
}

/**
 * Input for buildCreateArgs — everything startResolveStream needs to
 * decide in order to spawn `swctl create`.  Extracted as a pure
 * function so the argv contract is regression-tested in
 * tests/integration/resolve_create_args.bats without having to run the
 * full SSE pipeline.
 */
export interface CreateArgsInput {
  issueId: string
  branchPrefix: 'fix' | 'feat' | 'chore'
  /** Resolved project name (e.g. "SwagCommercial") or null = platform/trunk. */
  project: string | null
  /** 'dev' → no --qa; 'qa' → --qa (swctl default differs — we're explicit). */
  mode: 'dev' | 'qa'
}

/**
 * Assemble the argv for `swctl create`.  The exact shape of this array
 * is the CONTRACT between the resolve server and the bash CLI — getting
 * it wrong silently (e.g. re-adding `--no-provision`, forgetting
 * `--qa`, passing `--project trunk`) produces broken instances that
 * only show symptoms at runtime.  The tests in
 * resolve_create_args.bats lock the shape down.
 *
 * Rules (each asserted by a dedicated test):
 *   - `create` is always first (positional verb).
 *   - `--qa` iff mode === 'qa'.
 *   - **No `--no-provision`** — regression guard for the v0.5.7→0.5.8 bug
 *     that shipped broken admin + storefront to resolve-created worktrees.
 *   - `--project <name>` iff project is truthy AND !== 'trunk'.
 *   - Positional tail: `<issueId> <branchPrefix>/<issueId>`.
 */
export function buildCreateArgs(input: CreateArgsInput): string[] {
  const args: string[] = ['create']
  if (input.mode === 'qa') args.push('--qa')
  // No --no-provision.  See the long-form comment in startResolveStream
  // for why; if you're about to re-add this, please read it first.
  if (input.project && input.project !== 'trunk') {
    args.push('--project', input.project)
  }
  const branchName = `${input.branchPrefix}/${input.issueId}`
  args.push(input.issueId, branchName)
  return args
}

/**
 * Input to buildSpawnArgs — everything needed to assemble a backend's
 * CLI invocation for a "new resolve" run.  Resume/ask use different
 * shapes and are handled elsewhere.
 */
export interface SpawnArgsInput {
  /** Which backend to invoke. */
  backend: 'claude' | 'codex'
  /** The prompt text (Claude: `/shopware-resolve <url>`; Codex: natural-language task description). */
  prompt: string
  /** RFC4122 UUID, preassigned so Claude's `--resume` works later.  Ignored by Codex (its session ids are assigned server-side). */
  sessionId: string
  /** Absolute path to the worktree the agent should operate in. */
  worktreePath: string
  /** Space-joined list of allowed tools for Claude's `--allowedTools`.  Codex has no per-call equivalent (uses `--sandbox` + config.toml). */
  allowedTools: string
}

/** Result of buildSpawnArgs — feed directly into `spawn(bin, args, ...)`. */
export interface SpawnArgsResult {
  bin: string
  args: string[]
}

/**
 * Assemble the (bin, argv) pair for a fresh resolve spawn.  Extracted as
 * a pure function so the CORRECT-BINARY contract is regression-guarded
 * by tests — prior to this, the spawn site hard-coded
 * `backendBinary('claude')` regardless of the user's selection, so
 * picking Codex in the UI silently still ran Claude.
 *
 * Claude flags (stable, well-documented):
 *   -p <prompt>
 *   --output-format stream-json   → one JSON event per line on stdout
 *   --verbose
 *   --permission-mode acceptEdits
 *   --allowedTools <space-joined>
 *   --session-id <uuid>           → enables later `--resume <uuid>`
 *   --effort max
 *   --add-dir <worktree>
 *
 * Codex flags (from `codex exec --help`, Codex CLI 0.x):
 *   --json                        → JSONL output to stdout (closest to Claude's stream-json)
 *   --full-auto                   → sandbox=workspace-write, skip approvals (what we want for
 *                                   agent automation; mirrors Claude's `acceptEdits`)
 *   --cd <worktree>               → working directory (Claude uses --add-dir instead)
 *   --skip-git-repo-check         → don't refuse to run in a non-git-root worktree (the swctl
 *                                   sw-<N> directories are worktrees off of trunk; Codex's own
 *                                   check wrongly refuses in some setups)
 *   <prompt>                      → positional
 *
 * Session semantics differ:
 *   - Claude accepts a pre-assigned UUID via `--session-id`, which means we
 *     can `claude --resume <uuid>` later from another endpoint.
 *   - Codex assigns session ids itself and persists them under
 *     `~/.codex/sessions/`.  `codex exec resume --last` or
 *     `codex exec resume <id>` is the resume pathway — incompatible with
 *     the pre-assigned model.  We ignore `input.sessionId` on the Codex
 *     path; resume support for Codex is a separate follow-up (requires
 *     capturing Codex's session id from its first-line output + plumbing
 *     it into metadata).
 */
export function buildSpawnArgs(input: SpawnArgsInput): SpawnArgsResult {
  if (input.backend === 'codex') {
    return {
      bin: backendBinary('codex'),
      args: [
        'exec',
        '--json',
        '--full-auto',
        '--skip-git-repo-check',
        '--cd', input.worktreePath,
        input.prompt,
      ],
    }
  }
  // claude (default)
  return {
    bin: backendBinary('claude'),
    args: [
      '-p', input.prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', input.allowedTools,
      '--session-id', input.sessionId,
      '--effort', 'max',
      '--add-dir', input.worktreePath,
    ],
  }
}

/**
 * Pick a conventional-commit branch prefix (fix / feat / chore) from an
 * issue's labels. Defaults to "fix" because Shopware issues skew toward
 * bug reports.
 */
export function branchPrefixFromLabels(labels: string[]): 'fix' | 'feat' | 'chore' {
  const lower = labels.map((l) => l.toLowerCase())
  // Match `n` as a whole word inside `l` — non-alphanumeric boundaries or
  // start/end of string on both sides.  The previous `l.includes(n)` check
  // was too loose: short keywords like "ci" matched any label containing
  // that 2-char substring (e.g. "extension/swag-commercial" → "chore"
  // because "commercial" contains "ci").  The regex escapes nothing —
  // callers pass literal latin keywords — but we still anchor on
  // non-alphanumerics so "bug-report" keeps matching "bug".
  const has = (...needles: string[]) =>
    lower.some((l) => needles.some((n) =>
      l === n ||
      l.endsWith('/' + n) ||
      new RegExp(`(^|[^a-z0-9])${n}([^a-z0-9]|$)`).test(l)
    ))

  // Feature / enhancement indicators
  if (has('feature', 'enhancement', 'new feature', 'improvement')) return 'feat'
  // Non-functional / maintenance indicators
  if (has('refactor', 'chore', 'docs', 'documentation', 'tech debt', 'cleanup', 'tooling', 'ci')) return 'chore'
  // Default to bug-fix
  return 'fix'
}

/**
 * Given a set of issue labels, return the first registered plugin-external
 * project whose name fuzzy-matches an `extension/<slug>` label. Returns null
 * when the issue is platform-scoped.
 *
 * Matching rule: split the label into words (e.g. "Custom-Products" →
 * ["custom", "products"]) and require every word to appear as a substring of
 * the plugin name (case-insensitive). This handles "Custom-Products" →
 * "SwagCustomizedProducts" (both "custom" and "products" are present).
 */
export function detectPluginScopeFromLabels(
  labels: string[],
  /**
   * Caller-supplied plugin list.  When omitted, the function falls back
   * to reading the on-disk projects registry (default).  Passing it
   * explicitly is required in contexts where the registry isn't
   * populated — e.g. `detectScopeWithAI` on CI runners where no user
   * ever ran `swctl project add`.
   */
  pluginNamesOverride?: string[],
): string | null {
  const plugins = pluginNamesOverride
    ?? readProjects().filter((p) => p.type === 'plugin-external').map((p) => p.name)
  if (plugins.length === 0) return null

  // Rank candidates by word count so multi-word labels beat single-word ones,
  // and longer matches win ties deterministically.
  const candidates: Array<{ plugin: string; score: number }> = []

  for (const label of labels) {
    const m = label.match(/^extension\/(.+)$/i)
    if (!m) continue
    const words = labelWords(m[1])
    if (words.length === 0) continue

    for (const plugin of plugins) {
      const target = plugin.toLowerCase()
      if (words.every((w) => target.includes(w))) {
        candidates.push({ plugin, score: words.join('').length })
      }
    }
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0].plugin
}

/**
 * Resolve-feature backends we know how to spawn.  New backends (e.g. a future
 * openai-api HTTP flow) plug in here + the switch in `spawnArgsFor*` helpers
 * below.  Keep in sync with the `_ai_*` helpers in the swctl bash script —
 * the contract (binary + flag surface per mode) must match so a fix
 * started via the UI can be resumed via the CLI and vice versa.
 */
export type ResolveBackend = 'claude' | 'codex'

/** Normalise a user-supplied / query-string backend value to a known tag. */
export function coerceBackend(input: string | undefined | null): ResolveBackend {
  const v = (input || '').toLowerCase()
  return v === 'codex' ? 'codex' : 'claude'
}

/**
 * Resolve the CLI binary for a backend.  `SWCTL_CLAUDE_BIN` /
 * `SWCTL_CODEX_BIN` let users point at a non-PATH binary (dev, CI, tests).
 * Mirrors `_ai_backend_binary` in swctl.
 */
export function backendBinary(backend: ResolveBackend): string {
  switch (backend) {
    case 'codex': return process.env.SWCTL_CODEX_BIN || 'codex'
    case 'claude':
    default:      return process.env.SWCTL_CLAUDE_BIN || 'claude'
  }
}

/**
 * Read RESOLVE_BACKEND from the instance env file.  Missing/empty → claude
 * (back-compat with pre-0.5.7 instances that only have CLAUDE_SESSION_ID).
 */
export function readInstanceBackend(issueId: string): ResolveBackend {
  const f = findInstanceEnvFile(issueId)
  if (!f) return 'claude'
  try {
    const content = fs.readFileSync(f, 'utf-8')
    const m = content.match(/^RESOLVE_BACKEND=(.*)$/m)
    if (!m) return 'claude'
    // Strip surrounding single quotes
    const raw = m[1].replace(/^'([\s\S]*)'$/, '$1')
    return coerceBackend(raw)
  } catch {
    return 'claude'
  }
}

/**
 * Generate a RFC4122 v4 UUID for Claude Code's `--session-id`.  Claude
 * Code validates the format (UUID with dashes) and rejects anything else.
 */
function newSessionId(): string {
  // Node 18+ has randomUUID; fallback to crypto.randomBytes-based hex if not.
  const anyCrypto = crypto as unknown as { randomUUID?: () => string }
  if (typeof anyCrypto.randomUUID === 'function') return anyCrypto.randomUUID()
  const b = crypto.randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * Locate the instance's env file by issueId.  Returns null if not found.
 * Metadata lives at `~/.local/state/swctl/instances/<projectSlug>/<id>.env`.
 */
function findInstanceEnvFile(issueId: string): string | null {
  if (!STATE_DIR) return null
  const instancesDir = path.join(STATE_DIR, 'instances')
  if (!fs.existsSync(instancesDir)) return null
  for (const project of fs.readdirSync(instancesDir)) {
    const candidate = path.join(instancesDir, project, `${issueId}.env`)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Atomically patch CLAUDE_* fields in an instance env file.  Replaces
 * existing lines in place; leaves unrelated lines untouched.
 */
function patchResolveMetadata(
  issueId: string,
  patch: Partial<{
    CLAUDE_SESSION_ID: string
    CLAUDE_RESOLVE_STATUS: string
    CLAUDE_RESOLVE_STEP: string
    CLAUDE_RESOLVE_STARTED: string
    CLAUDE_RESOLVE_COST: string
    RESOLVE_BACKEND: string
    // Audit trail for AI-assisted scope + branch-prefix detection (0.5.7+).
    // Three discrete keys (not JSON) so `swctl doctor` / a shell one-liner
    // can grep them without jq.
    SCOPE_DETECTION_METHOD: string     // 'ai' | 'heuristic' | 'fallback' | 'user'
    SCOPE_DETECTION_CONFIDENCE: string // '0.00'..'1.00'
    SCOPE_DETECTION_REASONING: string  // ≤140 chars
  }>,
): void {
  const f = findInstanceEnvFile(issueId)
  if (!f) return
  let content: string
  try { content = fs.readFileSync(f, 'utf-8') } catch { return }

  for (const [key, rawValue] of Object.entries(patch)) {
    if (rawValue == null) continue
    // Match the swctl shell-quoting convention: printf '%q' on bash tends
    // to output unquoted-if-safe, quoted-if-not.  We just wrap in single
    // quotes and escape embedded single quotes — enough for our values.
    const quoted = `'${String(rawValue).replace(/'/g, `'\\''`)}'`
    const line = `${key}=${quoted}`
    const re = new RegExp(`^${key}=.*$`, 'm')
    if (re.test(content)) {
      content = content.replace(re, line)
    } else {
      // Append if missing (older env files might not have the field)
      content = content.replace(/\s*$/, '') + '\n' + line + '\n'
    }
  }

  try {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    // Atomic write: temp file on same filesystem + rename.  Prevents
    // torn writes when CLI edits run concurrently with the UI.
    const tmp = `${f}.tmp.${process.pid}.${Date.now()}`
    fs.writeFileSync(tmp, content, 'utf-8')
    fs.renameSync(tmp, f)
  } catch (err) {
    console.warn('[resolve] failed to patch metadata:', err)
  }
}

/**
 * Lightweight SSE-side stream parser.  Called on each log line we forward
 * to the browser.  Accumulates the last-completed step number and any
 * session id Claude reports (used as fallback when our preassigned id
 * is unknown).  Also tracks final cost from the terminal `result` event.
 */
interface ResolveStreamState {
  sessionId: string
  lastCompletedStep: number
  cost: number
}

function observeStreamLine(state: ResolveStreamState, raw: string): void {
  const trimmed = (raw || '').trim()
  if (!trimmed.startsWith('{')) {
    // Plain text line — may carry a step END marker (swctl-forwarded)
    const m = trimmed.match(/^###\s*STEP\s+(\d)\s+END\b/i)
    if (m) state.lastCompletedStep = Math.max(state.lastCompletedStep, parseInt(m[1], 10))
    return
  }
  let ev: any
  try { ev = JSON.parse(trimmed) } catch { return }

  if (ev.type === 'system' && typeof ev.session_id === 'string') {
    if (!state.sessionId) state.sessionId = ev.session_id
  }

  if (ev.type === 'assistant' && ev.message?.content) {
    const blocks = Array.isArray(ev.message.content) ? ev.message.content : []
    for (const b of blocks) {
      if (b?.type === 'text' && typeof b.text === 'string') {
        const matches = b.text.matchAll(/###\s*STEP\s+(\d)\s+END\b/gi)
        for (const m of matches) {
          state.lastCompletedStep = Math.max(state.lastCompletedStep, parseInt(m[1], 10))
        }
      }
    }
  }

  if (ev.type === 'result') {
    if (typeof ev.total_cost_usd === 'number') state.cost = ev.total_cost_usd
  }
}

/**
 * Spawn Claude Code non-interactively with the shopware-resolve skill and
 * stream its output back to the caller via SSE.
 *
 * Before launching Claude, creates a worktree for the issue (if one doesn't
 * already exist) so the instance appears in the Dashboard and Detail view.
 */
export function startResolveStream(
  c: Context,
  params: { issue: string; project?: string; mode?: 'qa' | 'dev'; backend?: string },
) {
  const { issue, project, mode } = params
  const backend: ResolveBackend = coerceBackend(params.backend)
  const home = process.env.HOME || '/root'

  // Extract issue number from URL or raw number
  const issueMatch = issue.match(/\/issues\/(\d+)/) || issue.match(/^(\d+)$/)
  const issueId = issueMatch ? issueMatch[1] : issue.replace(/\D/g, '')

  // The skill's own SKILL.md carries the ground rules, per-step artifact
  // requirements, and stop criterion — see
  // `skills/shopware-resolve/SKILL.md` "Ground rules" / "Required
  // artifact per step" sections.  All three entry points (swctl UI,
  // swctl CLI, direct `claude /shopware-resolve`) use those same rules,
  // so we keep this prompt minimal: just the slash command + the
  // explicit issue id for Step 5.
  const prompt = `/shopware-resolve ${issue}\n\n(issue id for Step 5 swctl refresh: ${issueId})`

  recordStart({ issue, project, mode })

  const streamId = `resolve:${issue}`

  // Stream SSE: first create worktree, then launch Claude
  return streamSSE(c, async (stream) => {
    const sendEvent = async (event: string, data: object) => {
      try { await stream.writeSSE({ event, data: JSON.stringify(data) }) } catch {}
    }

    // Step 1: Check if worktree already exists
    const existing = readAllInstances().find((i: any) => i.issueId === issueId)

    // If an instance exists, do a sanity-check: does its scope match what we
    // would have detected from the issue's labels? If not, warn the user and
    // refuse to proceed — this is usually a stale instance created before
    // the label-based scope detection worked.
    if (existing && !project) {
      try {
        const labels = await fetchIssueLabels(issue)
        const detected = labels.length > 0 ? detectPluginScopeFromLabels(labels) : null
        const actualPlugin: string = (existing as any).pluginName || ''
        if (detected && detected !== actualPlugin) {
          await sendEvent('log', { line: `[scope] existing instance is scoped to ${actualPlugin || 'platform/trunk'} but the issue labels point at ${detected}`, ts: Date.now() })
          await sendEvent('log', { line: `[scope] this is likely a stale instance — run 'swctl clean ${issueId}' and retry to recreate with the correct plugin scope`, ts: Date.now() })
          await sendEvent('done', { exitCode: 1, elapsed: 0 })
          return
        }
      } catch {
        // best-effort check; don't block if detection fails
      }
    }

    // Hoisted so the downstream patchResolveMetadata call can persist the
    // audit fields regardless of which branch below populated them.
    let aiDecision: AiScopeDecision | null = null

    if (!existing) {
      await sendEvent('log', { line: `[swctl] Creating worktree for #${issueId}...`, ts: Date.now() })

      // Fetch labels once and reuse for scope detection + branch prefix.
      const labels = await fetchIssueLabels(issue)
      if (labels.length > 0) {
        await sendEvent('log', { line: `[scope] issue labels: ${labels.join(', ')}`, ts: Date.now() })
      } else {
        await sendEvent('log', { line: `[scope] couldn't fetch issue labels → defaulting to platform scope + fix/ branch prefix`, ts: Date.now() })
      }

      // --- Scope + branch-prefix detection ---
      //
      // Precedence (first match wins):
      //   1. `params.project` explicitly passed by the caller (UI "project"
      //      dropdown or API query-string override).  AI is NEVER invoked.
      //   2. `features.resolveEnabled=true` → run detectScopeWithAI.  It
      //      fast-paths to the heuristic when labels are unambiguous, or
      //      spawns the configured backend with a single-shot classifier
      //      prompt when they're not.  Always returns a best-effort
      //      decision; never throws.
      //   3. Resolve feature disabled → fall back to the pre-0.5.7
      //      heuristic-only behaviour verbatim (regression-safe).
      //
      // All paths eventually set `effectiveProject` + `prefix` and emit
      // one `[scope] …` SSE log line carrying the decision, method, and
      // confidence so the user can audit the routing at a glance.
      let effectiveProject = project
      let prefix: 'fix' | 'feat' | 'chore'

      if (project) {
        await sendEvent('log', { line: `[scope] user → project=${project} (explicit override)`, ts: Date.now() })
        prefix = branchPrefixFromLabels(labels)
        aiDecision = {
          project,
          branchPrefix: prefix,
          confidence: 1,
          reasoning: 'user-provided project',
          method: 'heuristic',
        }
      } else if (isResolveEnabled()) {
        const info = await fetchIssueInfo(issue)
        aiDecision = await detectScopeWithAI({
          issueTitle: info?.title ?? '',
          issueBody:  (info?.body ?? '').slice(0, 2000),
          labels,
          backend,
          pluginNames: readProjects()
            .filter((p: any) => p.type === 'plugin-external')
            .map((p: any) => p.name),
        })
        effectiveProject = aiDecision.project ?? undefined
        prefix = aiDecision.branchPrefix
        await sendEvent('log', {
          line: `[scope] ${aiDecision.method} → project=${effectiveProject ?? 'platform'} prefix=${prefix}/ conf=${aiDecision.confidence.toFixed(2)} — ${aiDecision.reasoning}`,
          ts: Date.now(),
        })
      } else {
        // Resolve feature disabled — preserve pre-0.5.7 legacy behaviour.
        const detected = labels.length > 0 ? detectPluginScopeFromLabels(labels) : null
        if (detected) {
          effectiveProject = detected
          await sendEvent('log', { line: `[scope] plugin detected from labels → ${detected}`, ts: Date.now() })
        } else if (labels.length > 0) {
          await sendEvent('log', { line: `[scope] no extension/* label matched a registered plugin → platform scope`, ts: Date.now() })
        }
        prefix = branchPrefixFromLabels(labels)
      }
      await sendEvent('log', { line: `[branch] prefix → ${prefix}/`, ts: Date.now() })

      // Build the `swctl create` argv through the pure helper — single
      // source of truth for the contract (regression-tested in
      // tests/integration/resolve_create_args.bats).  History: the prior
      // inline assembly used to emit `--no-provision`, which shipped
      // broken admin + storefront to every resolve-created worktree
      // (see the commit that introduced buildCreateArgs for the full
      // postmortem).  Don't re-add any flags here — add them to the
      // helper (and add a test).
      const createArgs = buildCreateArgs({
        issueId,
        branchPrefix: prefix,
        project: effectiveProject ?? null,
        mode: mode === 'dev' ? 'dev' : 'qa',
      })
      await sendEvent('log', { line: `[swctl] swctl ${createArgs.join(' ')}`, ts: Date.now() })

      // Serialise the actual spawn through the CreateQueue — see class
      // comment.  Emit queue depth so the user sees what's happening
      // when their request is behind others.
      const result = await createQueue.run(
        () => spawnSwctl(createArgs),
        (ahead) => {
          if (ahead > 0) {
            sendEvent('log', {
              line: `[swctl] Queued — ${ahead} create${ahead === 1 ? '' : 's'} ahead.`,
              ts: Date.now(),
            }).catch(() => {})
          }
        },
        () => {
          sendEvent('log', { line: `[swctl] Running now.`, ts: Date.now() }).catch(() => {})
        },
      )

      if (result.ok) {
        await sendEvent('log', { line: `[swctl] Worktree ready.`, ts: Date.now() })
        emit({ type: 'instance-changed' })
      } else {
        // Abort the resolve — launching Claude against a missing worktree only
        // results in a confusing "done exit 0" run with nothing to show for it.
        await sendEvent('log', { line: `[swctl] Worktree creation FAILED — aborting resolve.`, ts: Date.now() })
        for (const line of result.output.split('\n').slice(-10)) {
          if (line.trim()) await sendEvent('log', { line: `[swctl] ${line}`, ts: Date.now() })
        }
        await sendEvent('done', { exitCode: 1, elapsed: 0 })
        return
      }
    } else {
      await sendEvent('log', { line: `[swctl] Worktree already exists for #${issueId}.`, ts: Date.now() })
    }

    // Step 2: Resolve worktree path for Claude
    const instance = readAllInstances().find((i: any) => i.issueId === issueId)
    const worktreePath = instance?.worktreePath || home

    await sendEvent('log', { line: `[claude] Starting /shopware-resolve ${issue}`, ts: Date.now() })

    // Step 3: Launch Claude Code
    //
    // Non-interactive runs need every tool Claude will use to be allow-listed
    // up-front — otherwise `Bash(gh …)`, `Bash(git commit …)`, etc. sit
    // waiting for a human approval that never comes.  We can't use
    // `--permission-mode bypassPermissions` because Claude Code refuses that
    // when run as root (which is how the swctl-ui container runs its node
    // process).  `--allowedTools` has no such root check.
    //
    // `--effort max` gives each turn the widest thinking budget so the skill
    // has room to actually execute every step instead of rushing to a summary.
    const allowedTools = [
      'Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob',
      'Task', 'WebFetch', 'WebSearch', 'TodoWrite',
    ].join(' ')
    // Pre-assign a session id so we can `claude --resume <uuid>` later
    // from the /api/skill/resolve/resume/stream endpoint.
    const sessionId = newSessionId()
    const claudeArgs = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', allowedTools,
      '--session-id', sessionId,
      '--effort', 'max',
      '--add-dir', worktreePath,
    ]

    // Persist the session id + running status up-front so a crash/abort
    // still leaves something the UI can resume from.  Also pin the
    // backend so resume/ask flows route to the correct binary.
    patchResolveMetadata(issueId, {
      CLAUDE_SESSION_ID: sessionId,
      CLAUDE_RESOLVE_STATUS: 'running',
      CLAUDE_RESOLVE_STEP: '0',
      CLAUDE_RESOLVE_STARTED: new Date().toISOString(),
      RESOLVE_BACKEND: backend,
      // One-line audit record of how scope+prefix got picked for this
      // instance.  Always written — even when AI was skipped — so the
      // fields are grep-stable across instances created before and after
      // the feature flag toggles.
      ...(aiDecision ? {
        SCOPE_DETECTION_METHOD:     aiDecision.method,
        SCOPE_DETECTION_CONFIDENCE: aiDecision.confidence.toFixed(2),
        SCOPE_DETECTION_REASONING:  aiDecision.reasoning,
      } : {
        SCOPE_DETECTION_METHOD:     'heuristic',
        SCOPE_DETECTION_CONFIDENCE: '0.00',
        SCOPE_DETECTION_REASONING:  'legacy (resolve feature disabled)',
      }),
    })

    const startTime = Date.now()
    // Resolve the actual (bin, args) pair for the SELECTED backend.  Before
    // v0.5.10 this block hard-coded `backendBinary('claude')` with a
    // "falling back to claude" warning log — so picking Codex in the UI
    // still spawned Claude.  The user hit this: the resolve log showed
    // `[claude] Starting /shopware-resolve ...` and `session started
    // model=claude-opus-4-7` even though they'd selected Codex.
    const spawnPlan = buildSpawnArgs({
      backend,
      prompt,
      sessionId,
      worktreePath,
      allowedTools,
    })
    await sendEvent('log', {
      line: `[${backend}] launching: ${spawnPlan.bin} ${spawnPlan.args.slice(0, 4).join(' ')}…`,
      ts: Date.now(),
    })
    if (backend === 'codex') {
      // Codex's resume is a separate CLI subcommand (`codex exec resume
      // --last|<id>`) — incompatible with Claude's pre-assigned UUID
      // model.  The `swctl resolve resume/ask` flows below still
      // spawn Claude for Codex-backed instances until that plumbing
      // lands.  First-run works; follow-ups fall back with a warning.
      await sendEvent('log', {
        line: `[codex] note: resume/ask for Codex-backed instances is not yet wired — use the CLI ('swctl resolve ask ${issueId} ...') until then.`,
        ts: Date.now(),
      })
    }
    const child = spawn(spawnPlan.bin, spawnPlan.args, {
      cwd: worktreePath,
      env: { ...process.env, HOME: home, TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const streamState: ResolveStreamState = {
      sessionId,
      lastCompletedStep: 0,
      cost: 0,
    }

    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line) {
          observeStreamLine(streamState, line)
          sendEvent('log', { line, ts: Date.now() })
        }
      }
    }

    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)

    stream.onAbort(() => { child.kill() })

    await new Promise<void>((resolve) => {
      child.on('close', (code) => {
        const exitCode = code || 0
        // Persist final state so the UI can render a Resume card and
        // `swctl resolve resume <id>` picks up the same session.
        patchResolveMetadata(issueId, {
          CLAUDE_SESSION_ID: streamState.sessionId || sessionId,
          CLAUDE_RESOLVE_STATUS: exitCode === 0 ? 'done' : 'failed',
          CLAUDE_RESOLVE_STEP: String(streamState.lastCompletedStep),
          CLAUDE_RESOLVE_COST: String(streamState.cost),
        })
        emit({ type: 'instance-changed' })
        sendEvent('done', {
          exitCode,
          elapsed: Date.now() - startTime,
          sessionId: streamState.sessionId || sessionId,
          lastCompletedStep: streamState.lastCompletedStep,
        }).then(resolve)
      })
      child.on('error', (err) => {
        patchResolveMetadata(issueId, {
          CLAUDE_RESOLVE_STATUS: 'failed',
          CLAUDE_RESOLVE_STEP: String(streamState.lastCompletedStep),
        })
        sendEvent('error', { message: err.message })
          .then(resolve)
      })
    })
  })
}

/**
 * Resume a previous resolve run for an issue.  Requires the instance env
 * file to carry a `CLAUDE_SESSION_ID` (written by `startResolveStream`
 * on any prior attempt).  Builds a continuation prompt that points
 * Claude at the step to pick up from and streams the output the same way
 * as a fresh run.
 */
export function startResolveResumeStream(
  c: Context,
  params: { issueId: string },
) {
  const { issueId } = params
  const home = process.env.HOME || '/root'

  const envFile = findInstanceEnvFile(issueId)
  if (!envFile) {
    return c.json({ error: `No instance found for ${issueId}` }, 404)
  }

  // Read CLAUDE_* + WORKTREE_PATH from env file
  const env = fs.readFileSync(envFile, 'utf-8')
  const read = (k: string) => {
    const m = env.match(new RegExp(`^${k}=(.*)$`, 'm'))
    if (!m) return ''
    // Strip surrounding single quotes if present
    return m[1].replace(/^'([\s\S]*)'$/, '$1').replace(/\\''/g, "'")
  }
  const sessionId = read('CLAUDE_SESSION_ID')
  const worktreePath = read('WORKTREE_PATH') || home
  const lastStepStr = read('CLAUDE_RESOLVE_STEP')
  const lastStep = parseInt(lastStepStr, 10) || 0
  const nextStep = Math.min(lastStep + 1, 8)

  if (!sessionId) {
    return c.json({ error: `No Claude session recorded for ${issueId}. Run a fresh resolve first.` }, 400)
  }

  // The skill's SKILL.md already carries the ground rules; the resumed
  // session still has them in context from the original run.  Keep the
  // continuation prompt a single sentence.
  const prompt =
    `Continue the previous /shopware-resolve run. You stopped after Step ${lastStep}. ` +
    `Pick up at Step ${nextStep} now, following the same ground rules from the skill.`

  return streamSSE(c, async (stream) => {
    const sendEvent = async (event: string, data: object) => {
      try { await stream.writeSSE({ event, data: JSON.stringify(data) }) } catch {}
    }

    await sendEvent('log', { line: `[resume] Continuing session ${sessionId.slice(0, 8)}... from Step ${nextStep}`, ts: Date.now() })

    const allowedTools = [
      'Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob',
      'Task', 'WebFetch', 'WebSearch', 'TodoWrite',
    ].join(' ')
    const claudeArgs = [
      '-p', prompt,
      '--resume', sessionId,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', allowedTools,
      '--effort', 'max',
      '--add-dir', worktreePath,
    ]

    patchResolveMetadata(issueId, {
      CLAUDE_RESOLVE_STATUS: 'running',
    })

    const resumeBackend = readInstanceBackend(issueId)
    if (resumeBackend !== 'claude') {
      await sendEvent('log', {
        line: `[resolve] backend=${resumeBackend} resume is not yet supported from the UI; falling back to claude. Use 'swctl resolve resume ${issueId}' from the CLI.`,
        ts: Date.now(),
      })
    }

    const startTime = Date.now()
    const child = spawn(backendBinary('claude'), claudeArgs, {
      cwd: worktreePath,
      env: { ...process.env, HOME: home, TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const streamState: ResolveStreamState = {
      sessionId,
      lastCompletedStep: lastStep,
      cost: 0,
    }

    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line) {
          observeStreamLine(streamState, line)
          sendEvent('log', { line, ts: Date.now() })
        }
      }
    }

    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)

    stream.onAbort(() => { child.kill() })

    await new Promise<void>((resolve) => {
      child.on('close', (code) => {
        const exitCode = code || 0
        patchResolveMetadata(issueId, {
          CLAUDE_SESSION_ID: streamState.sessionId || sessionId,
          CLAUDE_RESOLVE_STATUS: exitCode === 0 ? 'done' : 'failed',
          CLAUDE_RESOLVE_STEP: String(streamState.lastCompletedStep),
          CLAUDE_RESOLVE_COST: String(streamState.cost),
        })
        emit({ type: 'instance-changed' })
        sendEvent('done', {
          exitCode,
          elapsed: Date.now() - startTime,
          sessionId: streamState.sessionId || sessionId,
          lastCompletedStep: streamState.lastCompletedStep,
        }).then(resolve)
      })
      child.on('error', (err) => {
        patchResolveMetadata(issueId, {
          CLAUDE_RESOLVE_STATUS: 'failed',
        })
        sendEvent('error', { message: err.message }).then(resolve)
      })
    })
  })
}

/**
 * Called by the UI after it receives the SSE 'done' event. Updates the
 * resolve-runs state file with the final status. Idempotent.
 */
export function finishResolveRun(issue: string, exitCode: number): void {
  recordFinish(issue, exitCode)
}

/**
 * Resume a Claude session for an issue and stream a follow-up question —
 * typically from the Diff tab's review widget.  Unlike the old minimal
 * version, this path uses the same guardrails as the main resolve
 * stream (tool allowlist + --effort max) AND brackets the Claude run
 * with head-sha checks so the UI can tell whether a commit actually
 * landed or Claude just described what it would do.
 */
export function askResolveStream(
  c: Context,
  params: { issueId: string; message: string },
) {
  const { issueId, message } = params
  const instance = findInstance(issueId)
  if (!instance) {
    return c.json({ error: `No instance found for ${issueId}` }, 404)
  }

  const home = process.env.HOME || '/root'
  const sessionId = instance.claudeSessionId

  // Resolve the git CWD (plugin subdir for plugin-external, else the
  // trunk worktree).  Same rule prAction() uses.
  const isPlugin = (instance as any).projectType === 'plugin-external' && !!(instance as any).pluginName
  const gitCwd = isPlugin
    ? `${instance.worktreePath}/custom/plugins/${(instance as any).pluginName}`
    : instance.worktreePath

  // Capture HEAD before we spawn Claude so we can tell whether the run
  // produced a new commit.  Null → we couldn't read it (e.g. missing
  // worktree); treat the "committed" flag as unknown.
  const headBefore = (() => {
    if (!gitCwd) return null
    try {
      return execSync(`git -C "${gitCwd}" rev-parse HEAD 2>/dev/null`, {
        encoding: 'utf-8', timeout: 5_000,
      }).trim() || null
    } catch { return null }
  })()

  const allowedTools = [
    'Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob',
    'Task', 'WebFetch', 'WebSearch', 'TodoWrite',
  ].join(' ')

  const args = [
    '-p', message,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', allowedTools,
    '--effort', 'max',
  ]

  if (sessionId) {
    args.push('--resume', sessionId)
  }

  if (instance.worktreePath) {
    args.push('--add-dir', instance.worktreePath)
  }

  return streamSSE(c, async (stream) => {
    const sendEvent = async (event: string, data: object) => {
      try { await stream.writeSSE({ event, data: JSON.stringify(data) }) } catch {}
    }

    const askBackend = readInstanceBackend(issueId)
    if (askBackend !== 'claude') {
      await sendEvent('log', {
        line: `[resolve] backend=${askBackend} ask is not yet supported from the UI; falling back to claude. Use 'swctl resolve ask ${issueId} "..."' from the CLI.`,
        ts: Date.now(),
      })
    }

    const startTime = Date.now()
    const child = spawn(backendBinary('claude'), args, {
      cwd: instance.worktreePath || home,
      env: { ...process.env, HOME: home, TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line) sendEvent('log', { line, ts: Date.now() })
      }
    }

    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)

    stream.onAbort(() => { child.kill() })

    await new Promise<void>((resolve) => {
      child.on('close', (code) => {
        const exitCode = code || 0

        // Re-read HEAD after Claude finishes.  A commit landed iff the
        // SHA moved.  We report the result to the UI so the review
        // banner can show a committed/not-committed indicator.
        let headAfter: string | null = null
        if (gitCwd) {
          try {
            headAfter = execSync(`git -C "${gitCwd}" rev-parse HEAD 2>/dev/null`, {
              encoding: 'utf-8', timeout: 5_000,
            }).trim() || null
          } catch {}
        }
        const committed = !!(headBefore && headAfter && headAfter !== headBefore)

        emit({ type: 'instance-changed' })
        sendEvent('done', {
          exitCode,
          elapsed: Date.now() - startTime,
          committed,
          headBefore,
          headAfter,
          gitCwd,
        }).then(resolve)
      })
      child.on('error', (err) => {
        sendEvent('error', { message: err.message }).then(resolve)
      })
    })
  })
}

/**
 * Shape returned by `getPrForIssue` / `getPrsForIssues`.
 */
export interface PrInfo {
  number?: number
  title?: string
  state?: string
  url?: string
  draft?: boolean
  repo?: string
}

/**
 * Derive the GitHub repo (`owner/name`) for a swctl instance.  Plugin fixes
 * go to `shopware/<PluginName>`, core fixes to `shopware/shopware`.
 */
function repoForInstance(instance: any): string {
  const raw = instance.pluginName
    ? `shopware/${instance.pluginName}`
    : (instance.project || 'shopware/shopware')
  return raw.includes('/') ? raw : 'shopware/shopware'
}

/** In-memory cache of recent `/pulls` page-1 responses, keyed by repo. */
interface PullsCacheEntry { at: number; pulls: any[] }
const pullsCache = new Map<string, PullsCacheEntry>()
const PULLS_CACHE_TTL_MS = 15_000

/**
 * Fetch the first page of `/pulls?state=all&sort=updated` for a repo.
 * Cached for `PULLS_CACHE_TTL_MS` so the resolve page's 15 s repaint timer
 * doesn't pound GitHub.
 */
async function fetchRecentPulls(repo: string, token: string | undefined): Promise<any[] | null> {
  const now = Date.now()
  const cached = pullsCache.get(repo)
  if (cached && now - cached.at < PULLS_CACHE_TTL_MS) return cached.pulls

  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/pulls?state=all&per_page=100&sort=updated&direction=desc`,
      { headers },
    )
    if (!res.ok) return null
    const pulls = await res.json() as any[]
    pullsCache.set(repo, { at: now, pulls })
    return pulls
  } catch {
    return null
  }
}

/** Map a `/pulls` item to our PrInfo shape. */
function toPrInfo(pr: any, repo: string): PrInfo {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.merged_at ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN',
    url: pr.html_url,
    draft: pr.draft,
    repo,
  }
}

/**
 * Resolve PR info for many issues at once.  Groups by target repo and does
 * ONE `/pulls` listing call per repo (cached), then matches branches in
 * memory.  Falls back to per-branch `/pulls?head=` for branches not found
 * in the first page (older PRs beyond the 100 most-recent).
 *
 * Output: one entry per requested issueId, null when no matching PR exists
 * or the instance has no branch/token.
 */
export async function getPrsForIssues(
  issueIds: string[],
  token?: string,
): Promise<Record<string, PrInfo | null>> {
  const result: Record<string, PrInfo | null> = {}
  if (!issueIds.length) return result

  if (!token) {
    const stateDir = process.env.SWCTL_STATE_DIR || ''
    if (stateDir) {
      try { token = fs.readFileSync(path.join(stateDir, 'github.token'), 'utf-8').trim() } catch {}
    }
  }

  // Build {repo → [{issueId, branch}]} and pre-fill null for unknown ids.
  const byRepo = new Map<string, Array<{ issueId: string; branch: string }>>()
  for (const id of issueIds) {
    const instance = findInstance(id)
    if (!instance?.branch) { result[id] = null; continue }
    const repo = repoForInstance(instance)
    const list = byRepo.get(repo) || []
    list.push({ issueId: id, branch: instance.branch })
    byRepo.set(repo, list)
  }

  await Promise.all(Array.from(byRepo.entries()).map(async ([repo, items]) => {
    const owner = repo.split('/')[0]
    const pulls = await fetchRecentPulls(repo, token)

    // Match against cached page-1 first.
    const unmatched: Array<{ issueId: string; branch: string }> = []
    for (const { issueId, branch } of items) {
      let hit: any = null
      if (pulls) {
        hit = pulls.find(p =>
          p?.head?.ref === branch &&
          // Same-repo head only — filters fork PRs with the same branch name.
          p?.head?.repo?.owner?.login === owner,
        )
      }
      if (hit) {
        result[issueId] = toPrInfo(hit, repo)
      } else {
        unmatched.push({ issueId, branch })
      }
    }

    // Fallback for branches older than the 100 most-recent PRs: one targeted
    // call per unmatched branch (still cheaper than the old N-per-issue flow
    // because every repo with any match short-circuits on page-1).
    if (!unmatched.length) return
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
    if (token) headers.Authorization = `Bearer ${token}`
    await Promise.all(unmatched.map(async ({ issueId, branch }) => {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${repo}/pulls?head=${owner}:${branch}&state=all&per_page=1`,
          { headers },
        )
        if (!res.ok) { result[issueId] = null; return }
        const prs = await res.json() as any[]
        result[issueId] = prs.length ? toPrInfo(prs[0], repo) : null
      } catch {
        result[issueId] = null
      }
    }))
  }))

  // Ensure every requested id has an entry (safety — shouldn't be necessary).
  for (const id of issueIds) if (!(id in result)) result[id] = null
  return result
}

/**
 * Get PR info for a single issue.  Thin wrapper around `getPrsForIssues`
 * so single-issue callers (PR preview, instance detail, etc.) share the
 * same cache as the batched resolve-page paint.
 */
export async function getPrForIssue(issueId: string, token?: string): Promise<PrInfo | null> {
  const map = await getPrsForIssues([issueId], token)
  return map[issueId] || null
}

/**
 * Fetch the full body (markdown) for a GitHub issue.  Used to populate
 * the "Reproduction" section in generated PR bodies.  Returns an empty
 * string on any failure.
 */
async function fetchIssueBody(issueRef: string): Promise<string> {
  const info = await fetchIssueInfo(issueRef)
  if (!info) return ''
  const token = readSwctlGithubToken()
  if (!token) return ''
  try {
    const res = await fetch(
      `https://api.github.com/repos/${info.owner}/${info.repo}/issues/${info.number}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
        },
      },
    )
    if (!res.ok) return ''
    const data = await res.json() as { body?: string }
    return (data.body || '').trim()
  } catch {
    return ''
  }
}

/**
 * Generate a rich PR body (Shopware PR #16215 style) via Claude Code.
 * Falls back to `null` on any failure — caller should substitute a
 * minimal 2-line body.
 *
 * Called at Create-PR time when `/tmp/pr-body.md` isn't already present
 * (i.e. the resolve skill's Step 7 didn't run).  Uses `claude -p` with
 * `--allowedTools ""` so Claude produces pure markdown and can't edit
 * files or shell out.
 */
async function generatePrBody(params: {
  gitCwd: string
  baseBranch: string
  branch: string
  prTitle: string
  linkRef: string
  issueRef: string
  home: string
}): Promise<string | null> {
  try {
    // Gather context: the issue text + the branch's diff stats + the
    // committed change.  Truncate aggressively so the prompt stays small.
    const issueInfo = await fetchIssueInfo(params.issueRef)
    const issueBody = await fetchIssueBody(params.issueRef)
    let diff = ''
    try {
      diff = execSync(
        `git -C "${params.gitCwd}" diff --stat "origin/${params.baseBranch}..HEAD" && echo '---' && git -C "${params.gitCwd}" diff "origin/${params.baseBranch}..HEAD"`,
        { encoding: 'utf-8', timeout: 10_000, maxBuffer: 4_000_000, shell: '/bin/bash' },
      )
    } catch {}
    const truncatedDiff = diff.length > 20_000 ? diff.slice(0, 20_000) + '\n…[truncated]' : diff

    const prompt = `You are generating a GitHub pull-request body.  Follow the EXACT structure used in Shopware core PRs (example: https://github.com/shopware/shopware/pull/16215):

## Summary
- <1-3 bullets: what changed and why, one line each>

Fixes ${params.linkRef}

## Root cause
<1 short paragraph: why the bug existed>

## Reproduction
1. <step>
2. <step>
…

## Test plan
- [ ] <check>
- [ ] <check>

## Flow Builder Impact
<either "None — …" with one-sentence justification, or a list of affected events/actions/rules>

RULES:
- Respond with ONLY the markdown body. No preamble, no code fences around the output, no commentary.
- Do NOT invent reproduction steps — extract them from the issue body's "How to reproduce" section when present.
- Keep each section terse; the whole body should fit in ~40 lines.
- If information is genuinely unknown, write a short honest placeholder (e.g. "To be verified").

INPUTS:

### Issue
Title: ${issueInfo?.title || 'unknown'}
${issueBody ? `Body:\n${issueBody}` : 'Body: (not available)'}

### PR title (commit subject)
${params.prTitle}

### Diff (stat + patch, truncated)
${truncatedDiff || '(no diff available)'}`

    // Call claude non-interactively with no tools at all — we only want
    // the markdown back.  --permission-mode default is fine because no
    // tool is allowed.
    const result = execSync(
      `claude -p ${JSON.stringify(prompt)} --output-format text --allowedTools "" 2>&1`,
      {
        encoding: 'utf-8',
        timeout: 120_000,
        maxBuffer: 1_000_000,
        cwd: params.gitCwd,
        env: { ...process.env, HOME: params.home, TERM: 'dumb' },
      },
    )
    const trimmed = result.trim()
    // Sanity check: the body should contain the Fixes link and at
    // least one `## ` section header.  Otherwise discard and fall back.
    if (!trimmed.includes(`Fixes ${params.linkRef}`) || !/##\s+\w+/.test(trimmed)) {
      return null
    }
    return trimmed
  } catch {
    return null
  }
}

/**
 * Look up the original GitHub issue URL for an instance.  Tries
 * resolve-runs.json (written by startResolveStream) first, then falls
 * back to `https://github.com/shopware/shopware/issues/<id>` — the
 * default repo for this project.
 */
function issueUrlForId(issueId: string): string {
  try {
    const runs = readRuns()
    const match = runs.find((r) => {
      const m = r.issue.match(/\/issues\/(\d+)/) || r.issue.match(/^(\d+)$/)
      return m && m[1] === issueId
    })
    if (match) return match.issue
  } catch {}
  return `https://github.com/shopware/shopware/issues/${issueId}`
}

/**
 * Resolve the git operating dir, target repo, and base branch for an
 * instance.  Shared by both preview and action paths.
 */
function prContext(issueId: string): {
  ok: boolean
  error?: string
  instance?: any
  isPlugin?: boolean
  gitCwd?: string
  branch?: string
  repo?: string
  baseBranch?: string
} {
  const instance = findInstance(issueId)
  if (!instance?.branch || !instance.worktreePath) {
    return { ok: false, error: `No instance/branch for ${issueId}` }
  }
  const isPlugin = instance.projectType === 'plugin-external' && !!instance.pluginName
  const gitCwd = isPlugin
    ? `${instance.worktreePath}/custom/plugins/${instance.pluginName}`
    : instance.worktreePath
  const branch = instance.branch

  let repo = 'shopware/shopware'
  try {
    const remoteUrl = execSync(`git -C "${gitCwd}" remote get-url origin 2>/dev/null`, { encoding: 'utf-8', timeout: 5_000 }).trim()
    const m = remoteUrl.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/)
    if (m) repo = `${m[1]}/${m[2]}`
  } catch {}
  if (repo === 'shopware/shopware' && isPlugin && instance.pluginName) {
    repo = `shopware/${instance.pluginName}`
  }

  let baseBranch = 'trunk'
  try {
    const head = execSync(`git -C "${gitCwd}" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null`, { encoding: 'utf-8', timeout: 5_000 }).trim()
    const short = head.replace(/^origin\//, '')
    if (short) baseBranch = short
  } catch {
    if (isPlugin) baseBranch = 'main'
  }
  return { ok: true, instance, isPlugin, gitCwd, branch, repo, baseBranch }
}

/**
 * Preview what `prAction('create')` would use: title, body, base branch,
 * target repo, link reference.  Non-mutating — safe to show in a modal
 * before the user confirms.
 */
export async function previewPrCreate(issueId: string): Promise<{
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
}> {
  const ctx = prContext(issueId)
  if (!ctx.ok) return { ok: false, error: ctx.error }
  const { gitCwd, branch, repo, baseBranch } = ctx as Required<typeof ctx>

  // Title derivation (same as in create flow).
  const issueUrl = issueUrlForId(issueId)
  const issueInfo = await fetchIssueInfo(issueUrl)
  let prTitle = ''
  if (issueInfo?.title) {
    const prefix = branchPrefixFromLabels(issueInfo.labels)
    prTitle = `${prefix}: ${issueInfo.title}`
  } else {
    try {
      prTitle = execSync(`git -C "${gitCwd}" log --format='%s' -1 "${branch}"`, { encoding: 'utf-8', timeout: 5_000 }).trim()
    } catch {
      prTitle = `fix: resolve issue #${issueId}`
    }
  }

  // Link ref (same-repo vs cross-repo).
  const issueOwner = issueInfo?.owner || 'shopware'
  const issueRepo = issueInfo?.repo || 'shopware'
  const linkRef = (issueOwner === repo.split('/')[0] && issueRepo === repo.split('/')[1])
    ? `#${issueId}`
    : `${issueOwner}/${issueRepo}#${issueId}`

  // Body precedence (same as create): skill file → generated → fallback.
  const fallbackBody = `Fixes ${linkRef}\n\nCreated by \`swctl resolve\`.`
  let body = fallbackBody
  let bodySource: 'skill' | 'generated' | 'fallback' = 'fallback'
  const skillBodyPath = '/tmp/pr-body.md'
  try {
    if (fs.existsSync(skillBodyPath)) {
      const fromSkill = fs.readFileSync(skillBodyPath, 'utf-8').trim()
      if (fromSkill && fromSkill.includes(`Fixes ${linkRef}`)) {
        body = fromSkill
        bodySource = 'skill'
      } else if (fromSkill) {
        body = `${fromSkill}\n\nFixes ${linkRef}`
        bodySource = 'skill'
      }
    }
  } catch {}
  if (bodySource === 'fallback') {
    const generated = await generatePrBody({
      gitCwd, baseBranch, branch, prTitle, linkRef,
      issueRef: issueUrl, home: process.env.HOME || '/root',
    })
    if (generated) { body = generated; bodySource = 'generated' }
  }

  // Commit count (informational — tells user how many commits will be squashed).
  let commitCount = 0
  try {
    const mergeBase = execSync(
      `git -C "${gitCwd}" merge-base HEAD "origin/${baseBranch}" 2>/dev/null || git -C "${gitCwd}" rev-list --max-parents=0 HEAD | tail -1`,
      { encoding: 'utf-8', timeout: 5_000, shell: '/bin/bash' },
    ).trim()
    if (mergeBase) {
      commitCount = parseInt(execSync(`git -C "${gitCwd}" rev-list --count "${mergeBase}..HEAD"`,
        { encoding: 'utf-8', timeout: 5_000 }).trim() || '0', 10)
    }
  } catch {}

  return { ok: true, title: prTitle, body, bodySource, repo, baseBranch, branch, linkRef, commitCount }
}

/**
 * Execute a PR action (push, create, merge, approve) using gh CLI.
 *
 * For `create`, optional `overrides` let the caller supply a user-edited
 * title / body / baseBranch (from the preview modal).  If an override is
 * absent the flow falls back to the same auto-derivation as previewPrCreate.
 */
export async function prAction(
  issueId: string,
  action: 'push' | 'create' | 'merge' | 'approve' | 'ready',
  overrides?: { title?: string; body?: string; baseBranch?: string },
): Promise<{ ok: boolean; output: string }> {
  const instance = findInstance(issueId)
  if (!instance?.branch || !instance.worktreePath) {
    return { ok: false, output: `No instance/branch for ${issueId}` }
  }

  // For plugin-external instances the fix commit lives in the nested
  // plugin worktree, not in the trunk worktree.  Push + log + pr-create
  // must all target that subdirectory, and the repo + base branch must
  // come from the plugin's own git remote — trunk is only the PLATFORM
  // default branch and would 404 on the plugin repo.
  const isPlugin = instance.projectType === 'plugin-external' && !!instance.pluginName
  const gitCwd = isPlugin
    ? `${instance.worktreePath}/custom/plugins/${instance.pluginName}`
    : instance.worktreePath
  const branch = instance.branch

  // Resolve repo + base branch from the git remote so we don't hardcode
  // assumptions like `shopware/<PluginName>` or `--base trunk`.
  let repo = 'shopware/shopware'
  try {
    const remoteUrl = execSync(`git -C "${gitCwd}" remote get-url origin 2>/dev/null`, { encoding: 'utf-8', timeout: 5_000 }).trim()
    // Accept both ssh (git@github.com:owner/repo.git) and https forms
    const m = remoteUrl.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/)
    if (m) repo = `${m[1]}/${m[2]}`
  } catch {
    // fallback below
  }
  if (repo === 'shopware/shopware' && isPlugin && instance.pluginName) {
    repo = `shopware/${instance.pluginName}`
  }

  let baseBranch = 'trunk'
  try {
    const head = execSync(`git -C "${gitCwd}" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null`, { encoding: 'utf-8', timeout: 5_000 }).trim()
    // e.g. "origin/main" → "main"
    const short = head.replace(/^origin\//, '')
    if (short) baseBranch = short
  } catch {
    if (isPlugin) baseBranch = 'main'
  }
  // User can override the base branch from the preview modal.
  if (overrides?.baseBranch && overrides.baseBranch.trim()) {
    baseBranch = overrides.baseBranch.trim()
  }

  // Inject the swctl-maintained GH token into every `gh` call.  The
  // container's `~/.config/gh/hosts.yml` is often stale (UI OAuth flow
  // writes to swctl's own token file, not gh's config), so without
  // GH_TOKEN every `gh` call hits HTTP 401.  The token file is populated
  // by `swctl auth login` and by the UI's GitHub auth flow.
  const ghToken = readSwctlGithubToken()
  const ghEnv = ghToken
    ? { ...process.env, GH_TOKEN: ghToken, GITHUB_TOKEN: ghToken }
    : process.env

  try {
    let output = ''
    switch (action) {
      case 'push':
        output = execSync(`git -C "${gitCwd}" push -u origin "${branch}" 2>&1`, { encoding: 'utf-8', timeout: 30_000 })
        break
      case 'create': {
        // Build a canonical PR title from the original GitHub issue:
        //   `<prefix>: <issue title>` (e.g. "fix: Show configuration …")
        // Fall back to the latest commit's subject if GitHub can't be
        // reached.  This gives every PR a title derived from the issue
        // regardless of how many ad-hoc review commits are on the branch.
        const issueUrl = issueUrlForId(issueId)
        const issueInfo = await fetchIssueInfo(issueUrl)
        let prTitle = ''
        if (overrides?.title && overrides.title.trim()) {
          prTitle = overrides.title.trim()
        } else if (issueInfo?.title) {
          const prefix = branchPrefixFromLabels(issueInfo.labels)
          prTitle = `${prefix}: ${issueInfo.title}`
        } else {
          prTitle = execSync(`git -C "${gitCwd}" log --format='%s' -1 "${branch}"`, { encoding: 'utf-8', timeout: 5_000 }).trim()
        }

        // Squash every commit on `branch` since the merge base with the
        // base branch into a single commit with the canonical title.
        // `reset --soft` keeps the working tree + index untouched; we
        // just rewrite the commit graph.
        let squashOut = ''
        try {
          const mergeBase = execSync(
            `git -C "${gitCwd}" merge-base HEAD "origin/${baseBranch}" 2>/dev/null || git -C "${gitCwd}" rev-list --max-parents=0 HEAD | tail -1`,
            { encoding: 'utf-8', timeout: 5_000, shell: '/bin/bash' },
          ).trim()
          if (!mergeBase) throw new Error(`Could not resolve merge-base with origin/${baseBranch}`)

          const commitCount = parseInt(
            execSync(`git -C "${gitCwd}" rev-list --count "${mergeBase}..HEAD"`,
              { encoding: 'utf-8', timeout: 5_000 }).trim() || '0',
            10,
          )
          if (commitCount > 1) {
            squashOut += `Squashing ${commitCount} commits since ${mergeBase.slice(0, 7)} into one.\n`
            execSync(`git -C "${gitCwd}" reset --soft "${mergeBase}"`, { encoding: 'utf-8', timeout: 5_000 })
          }
          // (re-)commit with the canonical title — even single-commit
          // branches get the title normalised.
          const safeTitle = prTitle.replace(/"/g, '\\"')
          execSync(
            `git -C "${gitCwd}" commit --allow-empty --amend -m "${safeTitle}" 2>&1 || ` +
            `git -C "${gitCwd}" commit --allow-empty -m "${safeTitle}" 2>&1`,
            { encoding: 'utf-8', timeout: 10_000, shell: '/bin/bash' },
          )
        } catch (squashErr: any) {
          return {
            ok: false,
            output:
              `Could not squash commits before PR create.\n` +
              `${squashErr?.stdout || ''}${squashErr?.stderr || squashErr?.message || ''}`,
          }
        }

        // Force-push the rewritten branch.  `--force-with-lease` refuses
        // the push if someone else has pushed to the branch in between.
        let pushOut = ''
        try {
          pushOut = execSync(`git -C "${gitCwd}" push --force-with-lease -u origin "${branch}" 2>&1`, {
            encoding: 'utf-8', timeout: 30_000,
          })
        } catch (pushErr: any) {
          return {
            ok: false,
            output:
              `Squashed locally but failed to push ${branch} to origin.\n` +
              `git output:\n${pushErr?.stdout || ''}${pushErr?.stderr || pushErr?.message || ''}`,
          }
        }

        // Body links the PR back to the original GitHub issue.  For
        // plugin-external runs this is typically a *cross-repo*
        // reference (the fix is in shopware/SwagCustomizedProducts but
        // the issue lives on shopware/shopware), so we need the full
        // owner/repo#N form — GitHub shows the reference in the issue's
        // timeline even though cross-repo auto-close is not supported.
        const issueOwner = issueInfo?.owner || 'shopware'
        const issueRepo = issueInfo?.repo || 'shopware'
        const linkRef = (issueOwner === repo.split('/')[0] && issueRepo === repo.split('/')[1])
          ? `#${issueId}`                                // same-repo → auto-close
          : `${issueOwner}/${issueRepo}#${issueId}`      // cross-repo → reference only
        // Body precedence:
        //   0. User-edited body from the preview modal (highest).
        //   1. `/tmp/pr-body.md` if the resolve skill's Step 7 wrote one.
        //   2. On-the-fly generation via `claude -p` (Shopware #16215 style).
        //   3. Minimal fallback: Fixes link + one-line attribution.
        const fallbackBody = `Fixes ${linkRef}\n\nCreated by \`swctl resolve\`.`
        let body = fallbackBody
        let bodySource = 'fallback'
        if (overrides?.body && overrides.body.trim()) {
          body = overrides.body
          bodySource = 'user-edited'
        } else {
          const skillBodyPath = '/tmp/pr-body.md'
          try {
            if (fs.existsSync(skillBodyPath)) {
              const fromSkill = fs.readFileSync(skillBodyPath, 'utf-8').trim()
              if (fromSkill && fromSkill.includes(`Fixes ${linkRef}`)) {
                body = fromSkill
                bodySource = 'skill (/tmp/pr-body.md)'
              } else if (fromSkill) {
                body = `${fromSkill}\n\nFixes ${linkRef}`
                bodySource = 'skill + Fixes inject'
              }
            }
          } catch {}
          if (bodySource === 'fallback') {
            const generated = await generatePrBody({
              gitCwd,
              baseBranch,
              branch,
              prTitle,
              linkRef,
              issueRef: issueUrl,
              home: process.env.HOME || '/root',
            })
            if (generated) {
              body = generated
              bodySource = 'generated'
            }
          }
        }
        // Pass the body via --body-file so newlines/backticks/quotes can't
        // be mangled by shell escaping.
        const bodyFile = `/tmp/pr-body-${issueId}-${Date.now()}.md`
        fs.writeFileSync(bodyFile, body, 'utf-8')
        const safeTitle = prTitle.replace(/"/g, '\\"')
        try {
          output = execSync(
            `gh pr create --repo "${repo}" --base "${baseBranch}" --head "${branch}" --title "${safeTitle}" --body-file "${bodyFile}" --assignee @me --draft 2>&1`,
            { encoding: 'utf-8', timeout: 30_000, cwd: gitCwd, env: ghEnv },
          )
          output = `$ squash\n${squashOut}$ git push --force-with-lease\n${pushOut}\n$ pr body source: ${bodySource}\n$ gh pr create …\n${output}`
          try { fs.unlinkSync(bodyFile) } catch {}
        } catch (ghErr: any) {
          return {
            ok: false,
            output:
              `Pushed ${branch} but \`gh pr create\` failed.\n` +
              `squash:\n${squashOut}\n` +
              `push output:\n${pushOut}\n\n` +
              `gh output:\n${ghErr?.stdout || ''}${ghErr?.stderr || ghErr?.message || ''}`,
          }
        }
        break
      }
      case 'merge':
        output = execSync(`gh pr merge "${branch}" --repo "${repo}" --squash --delete-branch 2>&1`, { encoding: 'utf-8', timeout: 30_000, env: ghEnv })
        break
      case 'approve':
        output = execSync(`gh pr review "${branch}" --repo "${repo}" --approve 2>&1`, { encoding: 'utf-8', timeout: 30_000, env: ghEnv })
        break
      case 'ready':
        output = execSync(`gh pr ready "${branch}" --repo "${repo}" 2>&1`, { encoding: 'utf-8', timeout: 30_000, env: ghEnv })
        break
    }
    // Emit so cache middleware invalidates `pr` + `instances` tags; any UI
    // refresh after push/create/merge now renders with fresh PR state.
    emit({ type: 'instance-changed' })
    return { ok: true, output: output.trim() }
  } catch (err: any) {
    return { ok: false, output: err.stderr || err.message || String(err) }
  }
}

function findInstance(issueId: string): any | null {
  const all = readAllInstances()
  return all.find((i: any) => i.issueId === issueId) || null
}
