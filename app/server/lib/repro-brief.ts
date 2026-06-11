/**
 * AI repro brief — the front door of the /repro flow (feat/repro-scenarios).
 *
 * Given an issue (+ optional user tags steering the focus), spawn the
 * user's configured AI backend ONE-SHOT (no tools, no worktree, no
 * instance) and get back a structured brief:
 *
 *   - what the bug actually is (summary)
 *   - what category of reproduction it needs (api / search / …)
 *   - what the instance must look like (ES on? which plugin project?)
 *   - setup → execute → check steps, human-readable
 *   - feasibility: can `swctl repro` run this automatically, or is it
 *     a manual checklist (admin-ui issues stay manual in v1)
 *   - a draft .swctl/repro.yml when feasibility permits
 *
 * Design constraints (decided in the brainstorm, 2026-06-12):
 *   - ONE-SHOT: a single `claude -p` / `codex exec` call, 15-40 s,
 *     no agentic tool use.  Brief quality depends on the issue text;
 *     that's the accepted trade-off for predictable cost + latency.
 *   - The brief is valuable even when feasibility=manual — it is the
 *     "what to reproduce, what to check" guide the user asked for.
 *   - Never throws: callers get { ok: false, error } and decide how
 *     to surface it.
 */

import { spawn } from 'child_process'
import { fetchIssueInfo, backendBinary, coerceBackend, type ResolveBackend } from './resolve.js'

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const BRIEF_CATEGORIES = [
  'api',              // store-api / admin-api returns inaccurate data
  'search',           // search/ES results wrong (instance needs ES)
  'storefront-html',  // server-rendered page content wrong
  'console',          // bin/console command fails / migration breaks
  'admin-ui',         // needs a real browser — manual in v1
  'other',
] as const
export type BriefCategory = typeof BRIEF_CATEGORIES[number]

export const BRIEF_FEASIBILITIES = ['auto', 'partial', 'manual'] as const
export type BriefFeasibility = typeof BRIEF_FEASIBILITIES[number]

export interface ReproBrief {
  category: BriefCategory
  feasibility: BriefFeasibility
  /** 1-2 sentences: what breaks, when, for whom. */
  summary: string
  /** Instance configuration the reproduction needs. */
  instanceNeeds: {
    enableEs: boolean
    /** Plugin project (e.g. "SwagCommercial") or null = platform/trunk. */
    project: string | null
    notes: string
  }
  /** Data/config preconditions in human language. */
  preconditions: string[]
  /** Setup steps (entities to create, config to flip). */
  setup: string[]
  /** The action(s) that trigger the bug. */
  execute: string[]
  /** What to compare — expected vs actual. */
  checks: string[]
  /**
   * Draft .swctl/repro.yml using the runner's verb vocabulary.
   * Present when feasibility is auto/partial; empty for manual.
   */
  scenarioYaml: string
  /** Anything that can't be automated or needs human judgment. */
  notes: string
}

export interface BriefResult {
  ok: boolean
  brief?: ReproBrief
  /** Issue metadata echoed back so the UI doesn't need a second fetch. */
  issue?: { number: string; title: string; htmlUrl: string; labels: string[] }
  error?: string
  /** Raw model output kept for debugging when parsing fails (truncated). */
  rawOutput?: string
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * The runner's verb vocabulary, embedded in the prompt so the model
 * drafts scenarios the bash runner can actually execute.  Keep in sync
 * with `swctl repro` (cmd_repro) once it lands.
 */
const SCENARIO_VOCABULARY = `
setup verbs (list items under "setup:"):
  - product: { name, price, stock }                  # creates product via admin-api
  - customer: { email, group }                       # creates customer via admin-api
  - admin-api: { method, path, body }                # raw Admin API call (escape hatch)
  - console: "<bin/console command>"                 # e.g. "dal:refresh:index"
execute verbs (list items under "execute:"):
  - request: { method, path, follow_redirects?, headers? }   # storefront or /store-api/* path
  - console: "<bin/console command>"
assert verbs (list items under "assert:"):
  - status: <int>                                    # HTTP status of last request
  - json_path: { path: "<jq path>", equals: <value> }
  - body_contains: "<string>"
  - body_not_contains: "<string>"
  - exit_code: <int>                                 # of last console command
  - stderr_contains: "<string>"
`.trim()

/** Pure prompt builder — unit-testable without spawning anything. */
export function buildBriefPrompt(input: {
  title: string
  body: string
  labels: string[]
  tags: string[]
}): string {
  const body = (input.body || '').slice(0, 6000)  // keep the one-shot cheap
  return [
    `You are swctl's reproduction analyst for Shopware 6 issues.  Reply with ONE JSON object and nothing else — no markdown, no code fences, no prose before or after.`,
    ``,
    `JSON schema (all keys required):`,
    `{`,
    `  "category": "api" | "search" | "storefront-html" | "console" | "admin-ui" | "other",`,
    `  "feasibility": "auto" | "partial" | "manual",`,
    `  "summary": string,                  // 1-2 sentences: what breaks, when`,
    `  "instanceNeeds": { "enableEs": boolean, "project": string|null, "notes": string },`,
    `  "preconditions": string[],          // data/config required before reproducing`,
    `  "setup": string[],                  // concrete steps to create that state`,
    `  "execute": string[],                // the action(s) that trigger the bug`,
    `  "checks": string[],                 // each: "expected X, bug shows Y"`,
    `  "scenarioYaml": string,             // draft scenario (see vocabulary) or "" when manual`,
    `  "notes": string                     // what can't be automated; "" if nothing`,
    `}`,
    ``,
    `Rules:`,
    `- "search" category implies instanceNeeds.enableEs=true.`,
    `- "project" MUST be a plugin name only when an extension/* label or the body clearly indicates a plugin (e.g. extension/Commercial → "SwagCommercial"); otherwise null.`,
    `- "admin-ui" issues (need real browser interaction/JS) → feasibility "manual", scenarioYaml "".`,
    `- feasibility "auto" only when EVERY setup/execute/check step maps onto the scenario vocabulary below; "partial" when some do.`,
    `- scenarioYaml must use ONLY this vocabulary:`,
    SCENARIO_VOCABULARY,
    ``,
    input.tags.length
      ? `User focus tags (weigh these heavily when categorising): ${input.tags.join(', ')}`
      : `User focus tags: (none)`,
    `GitHub labels: ${input.labels.length ? input.labels.join(', ') : '(none)'}`,
    ``,
    `Issue title: ${input.title}`,
    `Issue body:`,
    body || '(empty body)',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Output parsing + validation
// ---------------------------------------------------------------------------

/**
 * Extract the first top-level JSON object from model output and
 * validate it into a ReproBrief.  Tolerates leading/trailing prose
 * (models occasionally ignore "nothing else").  Returns null when no
 * valid brief can be recovered — caller surfaces rawOutput for
 * debugging.
 */
export function parseBriefOutput(stdout: string): ReproBrief | null {
  const start = stdout.indexOf('{')
  if (start < 0) return null
  // Walk to the matching close brace (string-aware enough for our needs:
  // JSON.parse does the real validation; we just need candidate slices).
  for (let end = stdout.lastIndexOf('}'); end > start; end = stdout.lastIndexOf('}', end - 1)) {
    let parsed: unknown
    try { parsed = JSON.parse(stdout.slice(start, end + 1)) } catch { continue }
    const brief = validateBrief(parsed)
    if (brief) return brief
  }
  return null
}

function validateBrief(v: unknown): ReproBrief | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>

  const category = (BRIEF_CATEGORIES as readonly string[]).includes(o.category as string)
    ? o.category as BriefCategory : null
  const feasibility = (BRIEF_FEASIBILITIES as readonly string[]).includes(o.feasibility as string)
    ? o.feasibility as BriefFeasibility : null
  if (!category || !feasibility) return null
  if (typeof o.summary !== 'string' || !o.summary.trim()) return null

  const strArr = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []

  const needsRaw = (o.instanceNeeds && typeof o.instanceNeeds === 'object')
    ? o.instanceNeeds as Record<string, unknown> : {}

  return {
    category,
    feasibility,
    summary: o.summary.trim(),
    instanceNeeds: {
      // search implies ES even if the model forgot the rule.
      enableEs: needsRaw.enableEs === true || category === 'search',
      project: typeof needsRaw.project === 'string' && needsRaw.project.trim()
        ? needsRaw.project.trim() : null,
      notes: typeof needsRaw.notes === 'string' ? needsRaw.notes : '',
    },
    preconditions: strArr(o.preconditions),
    setup: strArr(o.setup),
    execute: strArr(o.execute),
    checks: strArr(o.checks),
    scenarioYaml: typeof o.scenarioYaml === 'string' ? o.scenarioYaml : '',
    notes: typeof o.notes === 'string' ? o.notes : '',
  }
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

const BRIEF_TIMEOUT_MS = 90_000   // generous; typical one-shot is 15-40 s

/** One-shot argv per backend — no tools, no editing permissions. */
function briefSpawnPlan(backend: ResolveBackend, prompt: string): { bin: string; args: string[] } {
  if (backend === 'codex') {
    return {
      bin: backendBinary('codex'),
      args: ['exec', '--skip-git-repo-check', prompt],
    }
  }
  return {
    bin: backendBinary('claude'),
    args: [
      '-p', prompt,
      '--output-format', 'text',
      // plan mode = the harness refuses edits even if the model tries;
      // belt-and-braces for a call that should be pure classification.
      '--permission-mode', 'plan',
      '--allowedTools', '',
    ],
  }
}

export async function generateReproBrief(input: {
  issue: string
  tags?: string[]
  backend?: string
}): Promise<BriefResult> {
  const info = await fetchIssueInfo(input.issue)
  if (!info) {
    return { ok: false, error: `Could not fetch issue "${input.issue}" — check the reference and the GitHub token (swctl auth login).` }
  }

  const prompt = buildBriefPrompt({
    title: info.title,
    body: info.body,
    labels: info.labels,
    tags: (input.tags || []).filter(Boolean),
  })
  const backend = coerceBackend(input.backend)
  const plan = briefSpawnPlan(backend, prompt)

  const { stdout, error } = await new Promise<{ stdout: string; error?: string }>((resolve) => {
    const child = spawn(plan.bin, plan.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      resolve({ stdout: out, error: `analysis timed out after ${BRIEF_TIMEOUT_MS / 1000}s` })
    }, BRIEF_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => { out += d })
    child.stderr.on('data', (d: Buffer) => { err += d })
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve({
        stdout: out,
        error: e.code === 'ENOENT'
          ? `backend binary not found: ${plan.bin} — check /#/config`
          : e.message,
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && !out.trim()) {
        resolve({ stdout: out, error: `${plan.bin} exited ${code}: ${err.slice(0, 300)}` })
      } else {
        resolve({ stdout: out })
      }
    })
  })

  const issueEcho = { number: info.number, title: info.title, htmlUrl: info.htmlUrl, labels: info.labels }
  if (error) return { ok: false, issue: issueEcho, error, rawOutput: stdout.slice(0, 2000) }

  const brief = parseBriefOutput(stdout)
  if (!brief) {
    return {
      ok: false,
      issue: issueEcho,
      error: 'Model output did not contain a valid brief JSON — retry, or try different tags.',
      rawOutput: stdout.slice(0, 2000),
    }
  }
  return { ok: true, issue: issueEcho, brief }
}

/**
 * Tags auto-seeded from GitHub labels — shown pre-ticked in the UI.
 * Pure + exported for tests.
 */
export function seedTagsFromLabels(labels: string[]): string[] {
  const tags = new Set<string>()
  for (const l of labels) {
    const lower = l.toLowerCase()
    if (/(component|domain)\/(search|elasticsearch)/.test(lower) || lower === 'elasticsearch') tags.add('search')
    if (/extension\//.test(lower)) tags.add('plugin')
    if (/storefront/.test(lower)) tags.add('storefront')
    if (/admin(istration)?/.test(lower)) tags.add('admin-ui')
    if (/checkout|cart/.test(lower)) tags.add('checkout')
    if (/performance/.test(lower)) tags.add('performance')
  }
  return [...tags]
}
