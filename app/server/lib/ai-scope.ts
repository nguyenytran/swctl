/**
 * AI-assisted plugin scope + branch prefix detection.
 *
 * Drop-in replacement for the brittle regex-only `detectPluginScopeFromLabels`
 * that used to be the only signal when a user triggers a resolve without
 * passing `--project`.  Flow:
 *
 *   1. Fast-path — if the existing pure heuristics agree on an unambiguous
 *      plugin + a non-default branch prefix, return them with
 *      `method: 'heuristic'`, confidence 1.0.  No spawn, no latency.
 *
 *   2. Otherwise spawn the user's resolve backend (Claude or Codex CLI)
 *      with a single-shot prompt that asks for a strict-JSON decision.
 *      Hard timeout 12 s; stdout parsed, validated against the registered
 *      plugin list, returned with `method: 'ai'`.
 *
 *   3. Any failure (ENOENT, non-zero exit, timeout, bad JSON, unknown
 *      plugin name) collapses to the raw heuristic with `method: 'fallback'`,
 *      confidence 0, reasoning that names the failure.  NEVER throws —
 *      the caller (`startResolveStream`) treats the result as best-effort
 *      and always proceeds to `swctl create`.
 *
 * Gated on `features.resolveEnabled` at the call site; this module itself
 * is pure and doesn't read the config flag (easier to test, easier to reuse
 * later if we add a CLI parity path).
 *
 * Safety: the prompt contains the issue body (PII).  It is NEVER logged
 * — we only log the final decision.  See fallback() below.
 */

import { spawn } from 'child_process'
import {
  backendBinary,
  branchPrefixFromLabels,
  detectPluginScopeFromLabels,
  type ResolveBackend,
} from './resolve.js'

export interface AiScopeInput {
  issueTitle: string
  /** Caller must already have sliced to ~2000 chars. */
  issueBody: string
  labels: string[]
  backend: ResolveBackend
  /** Registered plugin names — passed in (not re-read here) for testability. */
  pluginNames: string[]
}

export interface AiScopeDecision {
  /** Plugin name from `pluginNames`, or null = shopware platform / trunk. */
  project: string | null
  branchPrefix: 'fix' | 'feat' | 'chore'
  /** 0..1. 1.0 = heuristic certain; 0.0 = fell all the way back. */
  confidence: number
  /** One-line human explanation, ≤140 chars.  Logged to SSE. */
  reasoning: string
  method: 'heuristic' | 'ai' | 'fallback'
}

// Per-backend timeouts.  Claude (-p single-shot) usually returns in
// 3-6s; Codex's first invocation is slower (~15-25s — model warmup,
// auth/login state checks, sandbox setup) so a single number doesn't
// fit both.  These match the slowest p99 we've seen in practice with
// some headroom; tune via env if your model picks a different one.
const AI_TIMEOUT_CLAUDE_MS = 12_000
const AI_TIMEOUT_CODEX_MS  = 30_000
function aiTimeoutFor(backend: ResolveBackend): number {
  return backend === 'codex' ? AI_TIMEOUT_CODEX_MS : AI_TIMEOUT_CLAUDE_MS
}
const MAX_STDOUT_BYTES = 16 * 1024 // AI is asked for a ~200 B JSON object
const STDOUT_LOG_CAP = 120

export async function detectScopeWithAI(input: AiScopeInput): Promise<AiScopeDecision> {
  // Always pass `input.pluginNames` explicitly — `detectPluginScopeFromLabels`
  // otherwise reads the on-disk projects registry, which may be empty in
  // contexts where this function is called (CI, probe harness, callers
  // that pre-load the plugin list from a non-disk source).  The caller
  // is the source of truth for which plugins exist for THIS decision.
  const heuristicProject = detectPluginScopeFromLabels(input.labels, input.pluginNames)
  const heuristicPrefix = branchPrefixFromLabels(input.labels)
  const heuristicConfident =
    heuristicProject !== null &&
    // branchPrefixFromLabels defaults to 'fix' — only treat non-default as a
    // positive signal.  'fix' may still be correct but it's also the zero-
    // information value, so we run the AI to double-check.
    heuristicPrefix !== 'fix'

  // ── Fast-path ──────────────────────────────────────────────────────────
  if (heuristicConfident) {
    return {
      project: heuristicProject,
      branchPrefix: heuristicPrefix,
      confidence: 1.0,
      reasoning: 'heuristic: unambiguous label match',
      method: 'heuristic',
    }
  }

  // ── AI path ────────────────────────────────────────────────────────────
  const bin = backendBinary(input.backend)
  const prompt = buildPrompt(input)
  const args = buildArgs(input.backend, prompt)
  const timeoutMs = aiTimeoutFor(input.backend)

  try {
    const stdout = await runOnce(bin, args, timeoutMs)
    const parsed = parseDecision(stdout, input.pluginNames)
    if (!parsed) {
      return fallback(input, heuristicProject, heuristicPrefix, bin,
        `parse/schema failure: ${truncate(stdout, STDOUT_LOG_CAP)}`)
    }
    return { ...parsed, method: 'ai' }
  } catch (err: any) {
    const reason = err?.code === 'ENOENT'
      ? `binary not found (${bin})`
      : err?.code === 'ETIMEDOUT'
        ? `timeout after ${timeoutMs} ms`
        : err?.message || String(err)
    return fallback(input, heuristicProject, heuristicPrefix, bin, reason)
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

function buildPrompt(input: AiScopeInput): string {
  const pluginList = input.pluginNames.length > 0
    ? input.pluginNames.join(', ')
    : '(none registered)'
  const labels = input.labels.length > 0 ? input.labels.join(', ') : '(none)'

  // Kept terse and instruction-first.  `-p` / `exec --message` CLIs have no
  // system role, so the rules and schema both sit inline before the data.
  return [
    'You are swctl\'s scope router. Reply with ONE JSON object and nothing else.',
    'No markdown, no prose, no code fences.',
    '',
    'Schema:',
    '{"project": string|null, "branchPrefix": "fix"|"feat"|"chore",',
    ' "confidence": number, "reasoning": string}',
    '',
    'Rules:',
    '- "project" MUST be exactly one name from the plugins list below, or null',
    '  (null = shopware platform / trunk).',
    '- "branchPrefix": "feat" for new capabilities, "chore" for refactors/docs/CI,',
    '  "fix" for bugs/regressions.',
    '- "confidence" 0..1.',
    '- "reasoning" ONE short sentence, ≤140 chars, no newlines.',
    '',
    `Plugins: ${pluginList}`,
    `Title: ${input.issueTitle}`,
    `Labels: ${labels}`,
    'Body:',
    input.issueBody,
  ].join('\n')
}

function buildArgs(backend: ResolveBackend, prompt: string): string[] {
  if (backend === 'codex') {
    // Codex 0.x's exec subcommand takes the prompt POSITIONALLY — there's
    // no `--message` flag (that was an early MVP guess that exited 2).
    // `--json` produces JSONL events; the parser walks every line for the
    // schema-shaped decision object (Codex wraps the model output in
    // `thread.started` / `item.completed` envelope events that the older
    // "first balanced { }" extractor would mis-grab).
    //
    // `--dangerously-bypass-approvals-and-sandbox` rather than `--full-auto`:
    // `--full-auto` triggers the workspace-write bwrap sandbox which
    // requires unprivileged user namespaces — not available in the
    // swctl-ui Alpine container.  Even if it did work, this call is
    // pure classification (no FS writes), so a sandbox is over-spec.
    // `--skip-git-repo-check` lets us run from any cwd.
    return [
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      prompt,
    ]
  }
  // Claude default.  `plan` permission mode blocks any tool usage (pure
  // classification — we don't want it editing files), and an empty
  // `--allowedTools` belts-and-braces that guarantee.
  return [
    '-p', prompt,
    '--output-format', 'text',
    '--permission-mode', 'plan',
    '--allowedTools', '',
  ]
}

/**
 * Spawn once, collect stdout up to MAX_STDOUT_BYTES, enforce a hard timeout.
 * Rejects with `{ code: 'ENOENT' | 'ETIMEDOUT' | <exit-code-string>, message }`
 * so the caller can distinguish failure kinds.
 */
function runOnce(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settleReject = (err: NodeJS.ErrnoException): void => {
      if (settled) return
      settled = true
      reject(err)
    }
    const settleResolve = (s: string): void => {
      if (settled) return
      settled = true
      resolve(s)
    }

    // spawn() itself can throw synchronously on some platforms when the
    // bin path contains null bytes or similarly malformed input.  Wrap
    // so those turn into rejects, not uncaught exceptions inside the
    // Promise executor.
    let child: import('child_process').ChildProcess
    try {
      child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      })
    } catch (err) {
      settleReject(err as NodeJS.ErrnoException)
      return
    }

    // Attach error listener FIRST — before any other listeners or timers
    // — so an async 'error' event (Linux node emits ENOENT this way
    // when the binary path doesn't exist) can't slip through as an
    // "unhandled 'error' event" and terminate the process.
    child.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      settleReject(err)
    })

    const chunks: Buffer[] = []
    let byteCount = 0
    let truncated = false
    child.stdout?.on('data', (b: Buffer) => {
      if (truncated) return
      if (byteCount + b.length > MAX_STDOUT_BYTES) {
        chunks.push(b.slice(0, MAX_STDOUT_BYTES - byteCount))
        byteCount = MAX_STDOUT_BYTES
        truncated = true
        try { child.kill('SIGTERM') } catch {}
      } else {
        chunks.push(b)
        byteCount += b.length
      }
    })

    // Drain stderr but discard — AI noise ("Loading model...") is not useful
    // and would only make log lines harder to interpret.
    child.stderr?.on('data', () => {})

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      const err: NodeJS.ErrnoException = new Error(`ai-scope: timeout after ${timeoutMs}ms`)
      err.code = 'ETIMEDOUT'
      settleReject(err)
    }, timeoutMs)

    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && !truncated) {
        const err: NodeJS.ErrnoException = new Error(`ai-scope: exit ${code}`)
        err.code = `EXIT_${code}`
        settleReject(err)
        return
      }
      settleResolve(Buffer.concat(chunks).toString('utf-8'))
    })
  })
}

/**
 * Walk every balanced `{...}` block in stdout, validating each against the
 * decision schema.  Return the first match.
 *
 * Why not "first balanced object"?  Codex `--json` is JSONL with several
 * envelope events per turn — `{"type":"thread.started",…}`,
 * `{"type":"turn.started"}`, then `{"type":"item.completed","item":{…,"text":…}}`
 * which actually contains the model's reply.  The decision JSON we want
 * is buried in `item.text`, not at the top of stdout.  The previous
 * "first balanced object" extractor always grabbed `thread.started` and
 * fell through to fallback (user-reported as `[scope] fallback → … parse
 * /schema failure: {"type":"thread.started",…}` for #6689).
 *
 * For Claude `-p --output-format text` stdout is the model reply directly,
 * so the first balanced object IS the decision — both backends are
 * handled by the same walker.  For maximum tolerance we also walk into
 * `item.text` strings (which themselves contain nested JSON) — those are
 * Codex's actual model output.
 */
function parseDecision(stdout: string, pluginNames: string[]): Omit<AiScopeDecision, 'method'> | null {
  for (const block of iterateBalancedObjects(stdout)) {
    const decision = tryDecision(block, pluginNames)
    if (decision) return decision

    // Codex envelope: { type: "item.completed", item: { type: "agent_message", text: "<JSON or prose>" } }
    // The text payload may be the actual decision wrapped in prose.
    let parsed: unknown
    try { parsed = JSON.parse(block) } catch { continue }
    const text = (parsed as any)?.item?.text
    if (typeof text === 'string') {
      for (const innerBlock of iterateBalancedObjects(text)) {
        const innerDecision = tryDecision(innerBlock, pluginNames)
        if (innerDecision) return innerDecision
      }
    }
  }
  return null
}

function tryDecision(block: string, pluginNames: string[]): Omit<AiScopeDecision, 'method'> | null {
  let obj: unknown
  try { obj = JSON.parse(block) } catch { return null }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null

  const o = obj as Record<string, unknown>
  // Skip Codex envelope events fast — they don't carry `branchPrefix`.
  if (typeof o.type === 'string' && !('branchPrefix' in o)) return null

  const project = o.project === null
    ? null
    : typeof o.project === 'string' && o.project.trim() !== ''
      ? o.project.trim()
      : undefined
  if (project === undefined) return null
  if (project !== null && !pluginNames.includes(project)) return null

  const branchPrefix = o.branchPrefix
  if (branchPrefix !== 'fix' && branchPrefix !== 'feat' && branchPrefix !== 'chore') return null

  const confidence = typeof o.confidence === 'number' && Number.isFinite(o.confidence)
    ? Math.max(0, Math.min(1, o.confidence))
    : null
  if (confidence === null) return null

  const reasoning = typeof o.reasoning === 'string'
    ? o.reasoning.replace(/\s+/g, ' ').trim().slice(0, 140)
    : ''
  if (!reasoning) return null

  return { project, branchPrefix, confidence, reasoning }
}

/**
 * Generator that walks the string tracking brace depth and yields each
 * balanced top-level `{...}` object.  Tolerates leading/trailing prose,
 * strings that contain braces, and JSONL.
 */
function* iterateBalancedObjects(s: string): Generator<string> {
  let start = -1
  let depth = 0
  let inString = false
  let escape = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (escape) { escape = false; continue }
      if (c === '\\') { escape = true; continue }
      if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; continue }
    if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        yield s.slice(start, i + 1)
        start = -1
      }
    }
  }
}

function fallback(
  input: AiScopeInput,
  heuristicProject: string | null,
  heuristicPrefix: 'fix' | 'feat' | 'chore',
  bin: string,
  reason: string,
): AiScopeDecision {
  // eslint-disable-next-line no-console
  console.warn(`[ai-scope] backend=${input.backend} bin=${bin} — ${reason}; falling back to heuristic`)
  return {
    project: heuristicProject,
    branchPrefix: heuristicPrefix,
    confidence: 0,
    reasoning: `ai fallback: ${reason.slice(0, 120)}`,
    method: 'fallback',
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…'
}
