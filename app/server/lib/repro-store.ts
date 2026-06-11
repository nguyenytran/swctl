/**
 * Persisted history of analyzed repro briefs (feat/repro-scenarios).
 *
 * Mirrors resolve-runs.json: a capped, atomically-written JSON array in
 * the swctl state dir.  Every successful analyze is recorded so the
 * /repro listing shows past analyses and can re-open a brief without
 * re-spending an AI call.  Keyed by issue number — re-analyzing an
 * issue replaces its prior record (most recent wins).
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ReproBrief } from './repro-brief.js'

const STATE_DIR = process.env.SWCTL_STATE_DIR || path.join(process.env.HOME || '/root', '.local/state/swctl')
const BRIEFS_FILE = path.join(STATE_DIR, 'repro-briefs.json')
const CAP = 50

export interface ReproBriefRecord {
  issue: string          // bare number, the listing key
  title: string
  htmlUrl: string
  labels: string[]
  tags: string[]
  backend: string
  analyzedAt: string     // ISO
  // Denormalised for the listing rows (avoid digging into brief):
  category: string
  feasibility: string
  project: string | null
  enableEs: boolean
  // Full brief for re-display without re-analyzing.
  brief: ReproBrief
}

function read(): ReproBriefRecord[] {
  if (!fs.existsSync(BRIEFS_FILE)) return []
  try {
    const v = JSON.parse(fs.readFileSync(BRIEFS_FILE, 'utf-8'))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function write(records: ReproBriefRecord[]): void {
  try {
    fs.mkdirSync(path.dirname(BRIEFS_FILE), { recursive: true })
    // Atomic temp+rename, same rationale as resolve-runs.json.
    const tmp = `${BRIEFS_FILE}.tmp.${process.pid}.${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(records.slice(0, CAP), null, 2))
    fs.renameSync(tmp, BRIEFS_FILE)
  } catch (err) {
    console.warn('[repro] failed to write briefs file:', err)
  }
}

// Serialise concurrent record() calls (two analyze streams finishing
// at once would otherwise lose one another's entry).
let chain: Promise<void> = Promise.resolve()

export function recordReproBrief(input: {
  issue: string
  title: string
  htmlUrl: string
  labels: string[]
  tags: string[]
  backend: string
  analyzedAt: string
  brief: ReproBrief
}): Promise<void> {
  const rec: ReproBriefRecord = {
    issue: input.issue,
    title: input.title,
    htmlUrl: input.htmlUrl,
    labels: input.labels,
    tags: input.tags,
    backend: input.backend,
    analyzedAt: input.analyzedAt,
    category: input.brief.category,
    feasibility: input.brief.feasibility,
    project: input.brief.instanceNeeds.project,
    enableEs: input.brief.instanceNeeds.enableEs,
    brief: input.brief,
  }
  const next = chain.then(() => {
    const records = read()
    // Drop any prior record for the same issue — re-analyze replaces.
    const deduped = records.filter((r) => r.issue !== rec.issue)
    write([rec, ...deduped])
  })
  chain = next.catch(() => {})
  return next
}

export function listReproBriefs(): ReproBriefRecord[] {
  return read()
}

/**
 * Look up the persisted brief for one issue (by bare number).  Used by
 * the resolve flow to detect "this issue was already reproduced" and
 * skip Step 1.  Accepts a URL/#ref and normalises to the trailing
 * number so resolve can pass its raw issue ref.
 */
export function getReproBrief(issueRef: string): ReproBriefRecord | null {
  const m = String(issueRef).match(/(\d+)\s*$/)
  const num = m ? m[1] : String(issueRef).trim()
  return read().find((r) => r.issue === num) || null
}

export function deleteReproBrief(issue: string): boolean {
  const records = read()
  const kept = records.filter((r) => r.issue !== issue)
  if (kept.length === records.length) return false
  write(kept)
  return true
}
