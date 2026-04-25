/**
 * Per-issue resolve transcripts: persistent record of every SSE log line
 * the resolve stream emitted, so the user can scroll back through what
 * the AI did AFTER the run finishes (the live log is ephemeral; once
 * the page reloads or the user picks a different issue it's gone).
 *
 * Storage: one append-only JSONL file per issue, alongside the existing
 * instance env file:
 *
 *   <STATE_DIR>/instances/<projectSlug>/<issueId>.transcript.jsonl
 *
 * Each line is `{"ts": <epoch_ms>, "line": <string>}`.  This is a
 * superset of what the SSE `log` event carries — all we add is durability.
 *
 * Reading + segmentation happens at HTTP-request time (the file is small,
 * a few hundred KB at worst, and segmentation is regex-cheap).  The
 * persisted format is intentionally append-only: no edits, no rewrites,
 * no JSON-array wrapping.  This makes the writer crash-safe — a partial
 * line at EOF is just skipped on read; we never lose earlier lines to
 * a half-baked file.
 *
 * Intentionally NOT persisting: SSE `done` payloads, `step-progress`
 * events.  Those are derived state; recompute on read from the line
 * stream.
 */

import * as fs from 'fs'
import * as path from 'path'

const STATE_DIR = process.env.SWCTL_STATE_DIR || ''

/** One persisted log row.  Matches the live SSE `log` event payload shape. */
export interface TranscriptRow {
  ts: number
  line: string
}

/**
 * One step's slice of the transcript, post-segmentation.  Lines belonging
 * to the step (between its START / END markers, inclusive of the markers
 * themselves so the UI can render them as headers).
 */
export interface TranscriptStep {
  /** Step number 1-8 per the shopware-resolve workflow.  0 = preamble. */
  step: number
  /** Human-readable name parsed from `### STEP N START: <name>`, or '' if no START. */
  name: string
  lines: TranscriptRow[]
  /** Aggregated token usage attributed to this step. */
  tokens: {
    input: number
    cachedInput: number
    output: number
    reasoning: number
  }
  /** Wall time inside this step, ms (last line ts - first line ts).  0 if step has 0 or 1 lines. */
  durationMs: number
}

export interface ParsedTranscript {
  steps: TranscriptStep[]
  totals: {
    /** Sum across all steps. */
    tokens: { input: number; cachedInput: number; output: number; reasoning: number }
    /** Final cost (USD) — read from Claude's terminal `result` event when present. */
    costUsd: number | null
    /** Total wall time. */
    durationMs: number
    /** Total line count.  Useful for "loading 8000-line transcript" UX hints. */
    lineCount: number
  }
}

// ── Path resolution ─────────────────────────────────────────────────────────

/**
 * Locate the transcript file for a given issue, mirroring how
 * findInstanceEnvFile resolves the project slug.  Returns null when
 * STATE_DIR is unset (test contexts, fresh install before init).
 */
export function transcriptPath(issueId: string): string | null {
  if (!STATE_DIR) return null
  const instancesDir = path.join(STATE_DIR, 'instances')
  if (!fs.existsSync(instancesDir)) return null

  // First pass: an existing instance with this id wins (most common path).
  for (const project of fs.readdirSync(instancesDir)) {
    const envFile = path.join(instancesDir, project, `${issueId}.env`)
    if (fs.existsSync(envFile)) {
      return path.join(instancesDir, project, `${issueId}.transcript.jsonl`)
    }
  }
  return null
}

/**
 * Same as transcriptPath but creates the project dir + ensures the file
 * exists; used by appenders before/at-stream-start when the instance env
 * file may not be flushed to disk yet.  Falls back to `default-project`
 * when SW_PROJECT_SLUG is unset (resolve runs outside a tracked project).
 */
export function ensureTranscriptPath(issueId: string, projectSlug?: string): string | null {
  if (!STATE_DIR) return null
  const slug = projectSlug || process.env.SW_PROJECT_SLUG || 'default-project'
  const dir = path.join(STATE_DIR, 'instances', slug)
  try { fs.mkdirSync(dir, { recursive: true }) } catch { return null }
  return path.join(dir, `${issueId}.transcript.jsonl`)
}

// ── Append (write side) ─────────────────────────────────────────────────────

/**
 * Append a single log line to the transcript.  Uses fs.appendFileSync so
 * a crash mid-write leaves at most a partially-flushed last line, which
 * the reader skips.  Cheap enough to call inline on every SSE log event
 * (200-1000 events per typical resolve run).
 *
 * Errors are swallowed — the live SSE stream is the user's authoritative
 * UX; persistence is best-effort.  A full disk shouldn't break the run.
 */
export function appendTranscriptLine(filePath: string, row: TranscriptRow): void {
  try {
    fs.appendFileSync(filePath, JSON.stringify(row) + '\n')
  } catch {
    // Swallow — see header.
  }
}

/**
 * Truncate the transcript on a fresh `swctl resolve <id>` start.  Without
 * this, retrying a failed run would leave the previous run's log
 * concatenated to the new one.
 */
export function resetTranscript(filePath: string): void {
  try { fs.writeFileSync(filePath, '') } catch {}
}

// ── Read + segment ──────────────────────────────────────────────────────────

const STEP_START_RE = /^###\s*STEP\s+(\d)\s+START\s*:?\s*(.*)$/i
const STEP_END_RE   = /^###\s*STEP\s+(\d)\s+END\b/i

/**
 * Read the on-disk transcript and segment it by `### STEP N` markers.
 * Token usage is extracted from JSON event lines (Claude stream-json
 * `assistant` events; Codex `--json` `turn.completed` events) and
 * attributed to whichever step is "active" at the time the event landed.
 */
export function parseTranscript(filePath: string): ParsedTranscript {
  const empty: ParsedTranscript = {
    steps: [],
    totals: {
      tokens: { input: 0, cachedInput: 0, output: 0, reasoning: 0 },
      costUsd: null,
      durationMs: 0,
      lineCount: 0,
    },
  }

  let raw: string
  try { raw = fs.readFileSync(filePath, 'utf-8') } catch { return empty }
  if (!raw.trim()) return empty

  const rows: TranscriptRow[] = []
  for (const rawLine of raw.split('\n')) {
    if (!rawLine) continue
    let parsed: unknown
    try { parsed = JSON.parse(rawLine) } catch { continue }
    if (!parsed || typeof parsed !== 'object') continue
    const r = parsed as Record<string, unknown>
    if (typeof r.ts !== 'number' || typeof r.line !== 'string') continue
    rows.push({ ts: r.ts, line: r.line })
  }
  if (rows.length === 0) return empty

  // Build the step buckets up front so even steps with zero markers still
  // appear in the result (consistent UI shape).
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

  let currentStep = 0          // 0 = preamble, before any STEP N START
  let costUsd: number | null = null

  for (const row of rows) {
    const startMatch = row.line.match(STEP_START_RE)
    const endMatch = !startMatch ? row.line.match(STEP_END_RE) : null

    if (startMatch) {
      currentStep = parseInt(startMatch[1], 10)
      const step = ensureStep(currentStep)
      if (!step.name) step.name = startMatch[2].trim()
      step.lines.push(row)
      continue
    }

    // Add line to the active step BEFORE checking for END so the END
    // marker is included in this step's slice (the UI uses it as a
    // section divider).
    ensureStep(currentStep).lines.push(row)

    if (endMatch) {
      // Don't reset currentStep — content between END and the next START
      // (e.g. a final summary) belongs to the same step until proven
      // otherwise.  Step boundaries are FRONT-anchored on START markers.
      continue
    }

    // Token + cost extraction from JSON event lines.
    const trimmed = row.line.trim()
    if (!trimmed.startsWith('{')) continue
    let ev: any
    try { ev = JSON.parse(trimmed) } catch { continue }

    // Claude stream-json: assistant event with usage on the message
    if (ev?.type === 'assistant' && ev.message?.usage) {
      const u = ev.message.usage
      const step = ensureStep(currentStep)
      step.tokens.input       += Number(u.input_tokens)               || 0
      step.tokens.cachedInput += Number(u.cache_read_input_tokens)    || 0
      step.tokens.output      += Number(u.output_tokens)              || 0
    }
    if (ev?.type === 'result' && typeof ev.total_cost_usd === 'number') {
      costUsd = ev.total_cost_usd
    }

    // Codex --json: turn.completed event with usage on the turn
    if (ev?.type === 'turn.completed' && ev.usage) {
      const u = ev.usage
      const step = ensureStep(currentStep)
      step.tokens.input       += Number(u.input_tokens)            || 0
      step.tokens.cachedInput += Number(u.cached_input_tokens)     || 0
      step.tokens.output      += Number(u.output_tokens)           || 0
      step.tokens.reasoning   += Number(u.reasoning_output_tokens) || 0
    }
  }

  // Finalise per-step durations.
  for (const step of stepsByNum.values()) {
    if (step.lines.length >= 2) {
      step.durationMs = step.lines[step.lines.length - 1].ts - step.lines[0].ts
    }
  }

  // Sort by step number; preamble (0) first, then 1..8, then any
  // > 8 chunks (shouldn't happen but be defensive).
  const steps = Array.from(stepsByNum.values()).sort((a, b) => a.step - b.step)

  // Aggregate totals.
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

  return { steps, totals }
}
