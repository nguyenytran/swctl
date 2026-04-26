/**
 * Per-issue resolve transcripts.
 *
 * Reads from the agent's canonical session log on disk — Claude Code's
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` or Codex's
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl` — and
 * normalises both into a uniform per-step shape that the UI renders.
 *
 * Why no own-file persistence?  Both agents already write a complete
 * record of every event to disk, and our SSE stream is a strict subset
 * of that.  Maintaining a parallel JSONL would (1) duplicate every
 * write, (2) drift on resume / external `claude --continue` runs, (3)
 * require migration tooling for runs that pre-date the parallel file.
 * Reading from the canonical source eliminates all three problems and
 * lets historical runs (pre-feature) just work.
 *
 * Backend selection comes from the per-issue env file's `RESOLVE_BACKEND`
 * + `CLAUDE_SESSION_ID` (which on Codex stores the thread_id) + `WORKTREE_PATH`.
 *
 * Token math:
 *   - Claude: assistant events carry `message.usage` per turn — sum them.
 *     Final cost: not in session log; we read it from the env file
 *     (CLAUDE_RESOLVE_COST written by observeStreamLine).
 *   - Codex: `event_msg/token_count` events carry total + last-turn
 *     usage.  We use the LAST token_count's `total_token_usage` for
 *     overall totals, and the per-turn `last_token_usage` for step
 *     attribution (added to whichever step is active when the event
 *     fires).
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const STATE_DIR = process.env.SWCTL_STATE_DIR || ''

// ── Public types — unchanged from the prior version, UI consumes these ──────

export interface TranscriptRow {
  ts: number
  line: string
}

export interface TranscriptStep {
  /** 0 = preamble (lines before any STEP marker), 1-8 = workflow steps. */
  step: number
  name: string
  lines: TranscriptRow[]
  tokens: { input: number; cachedInput: number; output: number; reasoning: number }
  durationMs: number
}

export interface ParsedTranscript {
  steps: TranscriptStep[]
  totals: {
    tokens: { input: number; cachedInput: number; output: number; reasoning: number }
    /** Final cost (USD) — only populated on Claude runs (Codex doesn't surface a cost). */
    costUsd: number | null
    durationMs: number
    lineCount: number
  }
  /** Source backend, surfaced so the UI can label "Claude transcript" / "Codex transcript". */
  backend: 'claude' | 'codex' | null
  /** True when the backing session log was found.  False = empty `steps`, UI shows empty state. */
  found: boolean
}

const EMPTY: ParsedTranscript = {
  steps: [],
  totals: {
    tokens: { input: 0, cachedInput: 0, output: 0, reasoning: 0 },
    costUsd: null,
    durationMs: 0,
    lineCount: 0,
  },
  backend: null,
  found: false,
}

// ── Public API — same shape as before, different implementation ─────────────

/**
 * Resolve and parse the session log for a given issue.  Returns EMPTY
 * (with `found: false`) when no session log can be located — the UI
 * surfaces "no transcript yet" without distinguishing between
 * "feature didn't run" and "session log missing".
 */
export function parseTranscript(issueId: string): ParsedTranscript {
  const meta = readInstanceMeta(issueId)
  if (!meta) return EMPTY

  if (meta.backend === 'claude') {
    const file = locateClaudeSessionFile(meta.worktreePath, meta.sessionId)
    if (!file) return EMPTY
    return parseClaudeSession(file, meta.costUsd)
  }
  if (meta.backend === 'codex') {
    const file = locateCodexSessionFile(meta.worktreePath, meta.startedAt)
    if (!file) return EMPTY
    return parseCodexSession(file)
  }
  return EMPTY
}

// Old append/reset/transcriptPath/ensureTranscriptPath functions are
// intentionally gone.  startResolveStream + startResolveResumeStream no
// longer call them; the only consumer is parseTranscript above.

/**
 * Cheap "is a transcript reachable for this issue" probe — locates the
 * session log without parsing it.  Used to decide whether to render the
 * 📊 button in the issues table (showing the button on rows that would
 * just open an empty modal is a UX paper-cut we'd rather avoid).
 *
 * Cost:
 *   - Claude: 1 fs.existsSync.  Microseconds.
 *   - Codex:  walks ~/.codex/sessions/ year/month/day buckets, reads
 *             the first line of each rollout file in the last 30 days,
 *             matches by cwd.  Bounded but not free.  Caller is expected
 *             to call this in a loop over a handful of issues; the
 *             walk repeats per call which is fine at typical scale
 *             (5–20 tracked instances, 5s response cache upstream).
 *             If perf becomes an issue, swap to a per-request cwd→file
 *             index built once and shared across all instances.
 */
export function hasTranscript(issueId: string): boolean {
  const meta = readInstanceMeta(issueId)
  if (!meta) return false
  if (meta.backend === 'claude') {
    return locateClaudeSessionFile(meta.worktreePath, meta.sessionId) !== null
  }
  if (meta.backend === 'codex') {
    return locateCodexSessionFile(meta.worktreePath, meta.startedAt) !== null
  }
  return false
}

/**
 * Surface the resolve backend recorded for an issue (`claude` / `codex`),
 * or `null` if the instance has no env file or RESOLVE_BACKEND wasn't
 * persisted (pre-0.5.7 runs).  Used by the issues table to render a
 * per-row backend badge so the user can tell at a glance which AI ran
 * each transcript.
 *
 * Cheap — same reader as hasTranscript, no file walking.
 */
export function getResolveBackend(issueId: string): 'claude' | 'codex' | null {
  const meta = readInstanceMeta(issueId)
  return meta ? meta.backend : null
}

// ── Instance metadata reader ────────────────────────────────────────────────

interface InstanceMeta {
  backend: 'claude' | 'codex'
  /** For Claude: session UUID — `--session-id` is honoured, the env
   *  field reliably contains the right id.  For Codex: also the
   *  pre-assigned UUID we passed to spawn — but Codex ignores it and
   *  generates its own thread_id, so for Codex we DON'T use this for
   *  the session-file lookup; we match by worktree + start time
   *  instead. */
  sessionId: string
  worktreePath: string
  /** ISO timestamp from CLAUDE_RESOLVE_STARTED — used as a tiebreaker
   *  when multiple Codex rollouts exist for the same worktree. */
  startedAt: string
  costUsd: number | null
}

/**
 * Read the per-issue env file and pull out the fields we need to find
 * the session log.  Returns null if the file or required fields are
 * missing.
 */
function readInstanceMeta(issueId: string): InstanceMeta | null {
  if (!STATE_DIR) return null
  const instancesDir = path.join(STATE_DIR, 'instances')
  if (!fs.existsSync(instancesDir)) return null

  let envFile: string | null = null
  for (const project of fs.readdirSync(instancesDir)) {
    const candidate = path.join(instancesDir, project, `${issueId}.env`)
    if (fs.existsSync(candidate)) { envFile = candidate; break }
  }
  if (!envFile) return null

  let raw: string
  try { raw = fs.readFileSync(envFile, 'utf-8') } catch { return null }

  const get = (key: string): string => {
    const m = raw.match(new RegExp(`^${key}=['"]?([^'"\n]*)['"]?\\s*$`, 'm'))
    return m ? m[1] : ''
  }

  const backendRaw = get('RESOLVE_BACKEND').toLowerCase()
  const backend: 'claude' | 'codex' | null =
    backendRaw === 'codex' ? 'codex' :
    backendRaw === 'claude' ? 'claude' :
    null
  // RESOLVE_BACKEND wasn't persisted on pre-0.5.7 runs; we treat
  // those as "no transcript" rather than guessing.
  if (!backend) return null

  const sessionId = get('CLAUDE_SESSION_ID')
  const worktreePath = get('WORKTREE_PATH')
  // Codex matches by worktree path (it ignores --session-id), so
  // sessionId is optional there.  Claude honours --session-id and we
  // need it to find the file.
  if (!worktreePath) return null
  if (backend === 'claude' && !sessionId) return null

  const costStr = get('CLAUDE_RESOLVE_COST')
  const costUsd = costStr && !isNaN(Number(costStr)) && Number(costStr) > 0
    ? Number(costStr)
    : null

  const startedAt = get('CLAUDE_RESOLVE_STARTED')

  return { backend, sessionId, worktreePath, startedAt, costUsd }
}

// ── Session-file locators ───────────────────────────────────────────────────

/**
 * Claude Code stores per-project session logs at
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * The encoded cwd is the absolute worktree path with every non-
 * alphanumeric character (except `-`) replaced by `-`.  Verified
 * against a live install: `/Users/ytran/Shopware/_worktrees/sw-6689`
 * → `-Users-ytran-Shopware--worktrees-sw-6689` (leading `/` → `-`,
 * `_` → `-`, double-dash from the `/_` adjacency).
 */
function locateClaudeSessionFile(worktreePath: string, sessionId: string): string | null {
  const home = process.env.HOME || os.homedir()
  const encoded = worktreePath.replace(/[^a-zA-Z0-9-]/g, '-')
  const candidate = path.join(home, '.claude', 'projects', encoded, `${sessionId}.jsonl`)
  return fs.existsSync(candidate) ? candidate : null
}

/**
 * Codex stores rollouts at
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<startTs>-<threadId>.jsonl
 *
 * We can't match by thread_id from the env file because Codex IGNORES
 * the `--session-id` we pre-assign and generates its own thread_id at
 * spawn time — the env file's CLAUDE_SESSION_ID is the pre-assigned
 * value, not the one Codex actually used.
 *
 * Instead, match by `cwd` (read from each rollout's first line —
 * `session_meta.payload.cwd`) and disambiguate by start time when
 * multiple resolve runs share the worktree.  `startedAtIso` from the
 * env file is the most-recent-run start; we pick the rollout whose
 * `session_meta.payload.timestamp` is closest to it.
 *
 * This scan is cheap in practice: rollout dirs are date-partitioned
 * and we only need the first line of each candidate file.  We bound
 * the scan to the last 30 days to avoid unbounded work as the corpus
 * grows.
 */
function locateCodexSessionFile(worktreePath: string, startedAtIso: string): string | null {
  const home = process.env.HOME || os.homedir()
  const root = path.join(home, '.codex', 'sessions')
  if (!fs.existsSync(root)) return null

  const startedAtMs = startedAtIso ? Date.parse(startedAtIso) : NaN
  const cutoffMs = Number.isFinite(startedAtMs) ? startedAtMs - 30 * 24 * 60 * 60 * 1000 : 0

  let best: { file: string; deltaMs: number } | null = null

  // Walk year/month/day buckets, newest first.  Files within a day
  // are not date-ordered by name, but mtime works well enough.
  const years = safeReaddir(root).sort().reverse()
  for (const year of years) {
    const yDir = path.join(root, year)
    if (!safeIsDir(yDir)) continue
    const months = safeReaddir(yDir).sort().reverse()
    for (const month of months) {
      const mDir = path.join(yDir, month)
      if (!safeIsDir(mDir)) continue
      const days = safeReaddir(mDir).sort().reverse()
      for (const day of days) {
        const dDir = path.join(mDir, day)
        if (!safeIsDir(dDir)) continue
        for (const f of safeReaddir(dDir)) {
          if (!f.endsWith('.jsonl') || !f.startsWith('rollout-')) continue
          const full = path.join(dDir, f)
          const meta = readCodexSessionMeta(full)
          if (!meta) continue
          if (meta.cwd !== worktreePath) continue
          // Cutoff — older than 30 days from the run start, drop.
          const tMs = Date.parse(meta.timestamp || '') || 0
          if (cutoffMs && tMs && tMs < cutoffMs) continue
          // Score by closeness to startedAtIso; if startedAt is missing,
          // prefer the most recent rollout for this cwd.
          const delta = Number.isFinite(startedAtMs) && tMs
            ? Math.abs(tMs - startedAtMs)
            : -tMs  // negative so larger-tMs wins (most recent)
          if (best === null || delta < best.deltaMs) {
            best = { file: full, deltaMs: delta }
          }
        }
      }
    }
  }
  return best ? best.file : null
}

/**
 * Read just the first line of a rollout file and pull `cwd` + start
 * `timestamp`.  The first line is `session_meta` and Codex stuffs the
 * entire model base-instructions text into its payload — that's
 * typically 8–16 KB for GPT-5 templates.  We read in 64 KB chunks
 * and grow until we hit a newline, capping at 256 KB to bound the
 * worst case.  Anything larger than that is almost certainly a
 * malformed file we shouldn't try to parse anyway.
 */
function readCodexSessionMeta(file: string): { cwd: string; timestamp: string } | null {
  const CHUNK = 64 * 1024
  const MAX = 256 * 1024
  let firstLine = ''
  try {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(CHUNK)
    let total = 0
    let done = false
    while (!done && total < MAX) {
      const n = fs.readSync(fd, buf, 0, CHUNK, total)
      if (n <= 0) break
      const chunk = buf.slice(0, n).toString('utf-8')
      const nl = chunk.indexOf('\n')
      if (nl >= 0) {
        firstLine += chunk.slice(0, nl)
        done = true
      } else {
        firstLine += chunk
        total += n
      }
    }
    fs.closeSync(fd)
  } catch { return null }
  if (!firstLine) return null

  let parsed: any
  try { parsed = JSON.parse(firstLine) } catch { return null }
  if (parsed?.type !== 'session_meta') return null
  const p = parsed.payload || {}
  if (typeof p.cwd !== 'string') return null
  return { cwd: p.cwd, timestamp: typeof p.timestamp === 'string' ? p.timestamp : '' }
}

function safeIsDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

function safeReaddir(p: string): string[] {
  try { return fs.readdirSync(p) } catch { return [] }
}

// ── Common: lines → step segments ───────────────────────────────────────────

const STEP_START_RE = /^###\s*STEP\s+(\d)\s+START\s*:?\s*(.*)$/i
const STEP_END_RE = /^###\s*STEP\s+(\d)\s+END\b/i

interface TokenedRow extends TranscriptRow {
  /** Optional per-row token attribution.  Aggregated into the active step. */
  tokens?: { input: number; cachedInput: number; output: number; reasoning: number }
}

/**
 * Walk a sequence of `{ts, line, tokens?}` rows, segment by STEP markers,
 * aggregate tokens per step.  Backend-agnostic — both Claude and Codex
 * produce step markers as plain text inside agent messages.
 */
function segmentRows(
  rows: TokenedRow[],
  costUsd: number | null,
  backend: 'claude' | 'codex' | null,
): ParsedTranscript {
  if (rows.length === 0) return { ...EMPTY, backend, found: backend !== null }

  const stepsByNum = new Map<number, TranscriptStep>()
  const ensureStep = (n: number): TranscriptStep => {
    let s = stepsByNum.get(n)
    if (!s) {
      s = {
        step: n,
        name: '',
        lines: [],
        tokens: { input: 0, cachedInput: 0, output: 0, reasoning: 0 },
        durationMs: 0,
      }
      stepsByNum.set(n, s)
    }
    return s
  }

  let currentStep = 0
  for (const row of rows) {
    const startMatch = row.line.match(STEP_START_RE)
    if (startMatch) {
      currentStep = parseInt(startMatch[1], 10)
      const step = ensureStep(currentStep)
      if (!step.name) step.name = startMatch[2].trim()
    }

    const step = ensureStep(currentStep)
    step.lines.push({ ts: row.ts, line: row.line })

    if (row.tokens) {
      step.tokens.input       += row.tokens.input
      step.tokens.cachedInput += row.tokens.cachedInput
      step.tokens.output      += row.tokens.output
      step.tokens.reasoning   += row.tokens.reasoning
    }
  }

  for (const s of stepsByNum.values()) {
    if (s.lines.length >= 2) {
      s.durationMs = s.lines[s.lines.length - 1].ts - s.lines[0].ts
    }
  }

  const steps = Array.from(stepsByNum.values()).sort((a, b) => a.step - b.step)

  const totals = {
    tokens: { input: 0, cachedInput: 0, output: 0, reasoning: 0 },
    costUsd,
    durationMs: rows[rows.length - 1].ts - rows[0].ts,
    lineCount: rows.length,
  }
  for (const s of steps) {
    totals.tokens.input       += s.tokens.input
    totals.tokens.cachedInput += s.tokens.cachedInput
    totals.tokens.output      += s.tokens.output
    totals.tokens.reasoning   += s.tokens.reasoning
  }

  return { steps, totals, backend, found: true }
}

// ── Claude session parser ───────────────────────────────────────────────────

/**
 * Walks Claude Code's session JSONL.  Each line is one of:
 *   - {type:"queue-operation", ...}           — skip
 *   - {type:"user|assistant|system", message:{...}, timestamp}
 * Inside `message.content` we find blocks of type `text`, `thinking`,
 * `tool_use`, `tool_result`.  Each interesting block becomes one row.
 * Tokens come from `assistant.message.usage`.
 */
function parseClaudeSession(file: string, costFromMeta: number | null): ParsedTranscript {
  const rows: TokenedRow[] = []
  let raw: string
  try { raw = fs.readFileSync(file, 'utf-8') } catch { return EMPTY }

  let totalCost: number | null = costFromMeta

  for (const lineRaw of raw.split('\n')) {
    if (!lineRaw) continue
    let ev: any
    try { ev = JSON.parse(lineRaw) } catch { continue }

    const ts = parseTs(ev.timestamp) || Date.now()

    if (ev.type === 'user' && ev.message?.content) {
      const text = stringifyClaudeContent(ev.message.content).trim()
      if (text) rows.push({ ts, line: text.startsWith('<command-') ? `[user] ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)}` : `[user] ${text.slice(0, 600)}` })
      continue
    }

    if (ev.type === 'assistant' && ev.message?.content) {
      const blocks = Array.isArray(ev.message.content) ? ev.message.content : []
      const usage = ev.message.usage || {}
      let tokensAttached = false
      const tokensFor = (): TokenedRow['tokens'] => ({
        input: Number(usage.input_tokens) || 0,
        cachedInput: Number(usage.cache_read_input_tokens) || 0,
        output: Number(usage.output_tokens) || 0,
        reasoning: 0,
      })

      for (const b of blocks) {
        const row: TokenedRow = { ts, line: '' }
        if (b?.type === 'text' && typeof b.text === 'string') {
          // Preserve internal newlines so STEP markers stay on their
          // own logical row (segmentRows checks line-by-line).
          for (const sub of b.text.split('\n')) {
            if (sub.trim()) rows.push({ ts, line: sub })
          }
          continue
        }
        if (b?.type === 'thinking' && typeof b.thinking === 'string') {
          row.line = `💭 ${b.thinking.replace(/\s+/g, ' ').trim().slice(0, 240)}`
        } else if (b?.type === 'tool_use') {
          const name = b.name || 'tool'
          const input = b.input || {}
          if (name === 'Bash') row.line = `▸ Bash: ${String(input.command || '').replace(/\s+/g, ' ').slice(0, 240)}`
          else if (name === 'Edit' || name === 'Write') row.line = `✎ ${name}: ${input.file_path || ''}`
          else if (name === 'Read') row.line = `📄 Read: ${input.file_path || ''}`
          else if (name === 'Task') row.line = `↻ Task: ${input.subagent_type || input.description || ''}`
          else if (name === 'Grep' || name === 'Glob') row.line = `🔎 ${name}: ${input.pattern || input.path || ''}`
          else row.line = `▸ ${name}: ${Object.entries(input).slice(0, 1).map(([k, v]) => `${k}=${String(v).replace(/\s+/g, ' ').slice(0, 120)}`).join('')}`
        } else if (b?.type === 'tool_result') {
          const text = typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map((c: any) => (c && typeof c === 'object' && typeof c.text === 'string') ? c.text : '').join('')
              : ''
          const firstLine = (text.split('\n').find((l: string) => l.trim()) || '').slice(0, 200)
          const totalLines = text.split('\n').length
          row.line = `⤷ ${firstLine}${totalLines > 1 ? ` (…${totalLines} lines)` : ''}`
        } else {
          continue
        }
        if (!tokensAttached) {
          row.tokens = tokensFor()
          tokensAttached = true
        }
        rows.push(row)
      }
      continue
    }

    if (ev.type === 'system' && typeof ev.text === 'string') {
      rows.push({ ts, line: `[system] ${ev.text}` })
    }
  }

  return segmentRows(rows, totalCost, 'claude')
}

function stringifyClaudeContent(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c: any) =>
      typeof c?.text === 'string' ? c.text : (c?.content || '')
    ).join(' ')
  }
  return ''
}

// ── Codex session parser ────────────────────────────────────────────────────

/**
 * Walks Codex's rollout JSONL.  Each line:
 *   - {type:"session_meta", ...}                — skip
 *   - {type:"turn_context", ...}                — skip
 *   - {type:"event_msg", payload:{type:"agent_message"|"task_started"|"task_complete"|"token_count"|"user_message", ...}}
 *   - {type:"response_item", payload:{type:"function_call"|"function_call_output"|"message"|"custom_tool_call"|...}}
 *
 * Token usage comes from `event_msg/token_count` payloads.  We use
 * `last_token_usage` per token_count event for per-step attribution
 * (each token_count fires after a model turn ends, attributing
 * tokens to whichever step the agent was working on).
 */
function parseCodexSession(file: string): ParsedTranscript {
  const rows: TokenedRow[] = []
  let raw: string
  try { raw = fs.readFileSync(file, 'utf-8') } catch { return EMPTY }

  for (const lineRaw of raw.split('\n')) {
    if (!lineRaw) continue
    let ev: any
    try { ev = JSON.parse(lineRaw) } catch { continue }

    const ts = parseTs(ev.timestamp) || Date.now()
    const p = ev.payload

    if (ev.type === 'event_msg') {
      const t = p?.type
      if (t === 'agent_message' && typeof p.message === 'string') {
        // Preserve newlines so STEP markers segment properly.
        for (const sub of String(p.message).split('\n')) {
          if (sub.trim()) rows.push({ ts, line: sub })
        }
      } else if (t === 'user_message' && typeof p.message === 'string') {
        rows.push({ ts, line: `[user] ${p.message.slice(0, 600)}` })
      } else if (t === 'task_started') {
        rows.push({ ts, line: `[codex] task started` })
      } else if (t === 'task_complete') {
        rows.push({ ts, line: `[codex] task complete` })
      } else if (t === 'token_count' && p.info && p.info.last_token_usage) {
        const u = p.info.last_token_usage
        // Attribute the LAST turn's usage to the row.  segmentRows
        // will roll it up into whichever step is active at this ts.
        rows.push({
          ts,
          line: '',  // empty line — we want the tokens but not a visible row.
          tokens: {
            input: Number(u.input_tokens) || 0,
            cachedInput: Number(u.cached_input_tokens) || 0,
            output: Number(u.output_tokens) || 0,
            reasoning: Number(u.reasoning_output_tokens) || 0,
          },
        })
      }
      continue
    }

    if (ev.type === 'response_item') {
      const t = p?.type
      if (t === 'function_call' && p.name) {
        let detail = ''
        try {
          const args = JSON.parse(p.arguments || '{}')
          if (p.name === 'exec_command' && typeof args.cmd === 'string') {
            detail = args.cmd.replace(/\s+/g, ' ').slice(0, 240)
          } else if (p.name === 'apply_patch' && typeof args.input === 'string') {
            const firstFile = args.input.match(/Add File:\s*(.+)|Update File:\s*(.+)|Delete File:\s*(.+)/)
            detail = firstFile ? (firstFile[1] || firstFile[2] || firstFile[3] || '').trim() : '<patch>'
          } else {
            detail = JSON.stringify(args).slice(0, 200)
          }
        } catch {
          detail = String(p.arguments || '').slice(0, 200)
        }
        rows.push({ ts, line: `▸ ${p.name}: ${detail}` })
      } else if (t === 'function_call_output' && typeof p.output === 'string') {
        const text = p.output
        const firstLine = (text.split('\n').find((l: string) => l.trim()) || '').slice(0, 200)
        const totalLines = text.split('\n').length
        rows.push({ ts, line: `⤷ ${firstLine}${totalLines > 1 ? ` (…${totalLines} lines)` : ''}` })
      } else if (t === 'message' && p.role && Array.isArray(p.content)) {
        const text = p.content.map((c: any) => typeof c?.text === 'string' ? c.text : '').join('')
        if (text.trim()) {
          // Most assistant text goes through agent_message events.  The
          // response_item/message variant is rarer (final summaries) —
          // still emit it line-by-line for STEP marker detection.
          for (const sub of text.split('\n')) {
            if (sub.trim()) rows.push({ ts, line: sub })
          }
        }
      } else if (t === 'custom_tool_call' && p.name) {
        rows.push({ ts, line: `▸ ${p.name}: <custom tool>` })
      }
    }
  }

  // Filter out the zero-content tokens-only rows BEFORE segmenting —
  // segmentRows treats every row as a visible line, so we'd otherwise
  // pad each step's line count with invisible entries.  Instead we
  // pre-merge token-only rows into the next visible row.
  const merged: TokenedRow[] = []
  let pendingTokens: TokenedRow['tokens'] | undefined
  for (const r of rows) {
    if (r.line === '' && r.tokens) {
      // Carry forward; if multiple token-counts back-to-back, accumulate.
      if (!pendingTokens) pendingTokens = { ...r.tokens }
      else {
        pendingTokens.input       += r.tokens.input
        pendingTokens.cachedInput += r.tokens.cachedInput
        pendingTokens.output      += r.tokens.output
        pendingTokens.reasoning   += r.tokens.reasoning
      }
      continue
    }
    if (pendingTokens) {
      merged.push({
        ...r,
        tokens: r.tokens
          ? {
              input: r.tokens.input + pendingTokens.input,
              cachedInput: r.tokens.cachedInput + pendingTokens.cachedInput,
              output: r.tokens.output + pendingTokens.output,
              reasoning: r.tokens.reasoning + pendingTokens.reasoning,
            }
          : pendingTokens,
      })
      pendingTokens = undefined
    } else {
      merged.push(r)
    }
  }
  // Trailing token-counts (no following row) — emit a final synthetic
  // row so they're not lost.
  if (pendingTokens) {
    const lastTs = rows[rows.length - 1]?.ts || Date.now()
    merged.push({ ts: lastTs, line: '[codex] final usage', tokens: pendingTokens })
  }

  return segmentRows(merged, null, 'codex')
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseTs(s: any): number {
  if (typeof s === 'number') return s
  if (typeof s !== 'string') return 0
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}
