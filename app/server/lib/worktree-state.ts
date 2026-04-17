import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import { readAllInstances } from './metadata.js'
import { getPrForIssue } from './resolve.js'
import { subscribe } from './events.js'

const execFileAsync = promisify(execFile)

export interface CleanupState {
  diskSizeBytes: number | null
  lastActivity: string | null     // ISO 8601
  dirty: boolean
  ahead: number
  behind: number
  prState: 'open' | 'draft' | 'merged' | 'closed' | null
}

interface CacheEntry {
  state: CleanupState
  expires: number
}

const TTL_MS = 5 * 60_000
const cache = new Map<string, CacheEntry>()

// Invalidate on any instance-state change so stale numbers never survive
// a user action. The subscribe hook already runs at server start.
subscribe((ev) => {
  if (ev.type === 'instance-changed') {
    cache.clear()
  }
})

// Run a command without blocking Node's event loop. `execSync` with Promise.all
// does NOT parallelise; it serialises on the main thread and freezes the UI
// server. Always use execFileAsync here.
async function runCmd(file: string, args: string[], timeoutMs: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 1_000_000,
    })
    return stdout.trim()
  } catch {
    return null
  }
}

function resolveGitCwd(inst: { worktreePath: string; projectType: string; pluginName: string }): string {
  const isPlugin = inst.projectType === 'plugin-external' && !!inst.pluginName
  return isPlugin
    ? path.join(inst.worktreePath, 'custom/plugins', inst.pluginName)
    : inst.worktreePath
}

async function resolveBaseBranch(gitCwd: string, fallback: string): Promise<string> {
  const head = await runCmd('git', ['-C', gitCwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 3000)
  if (head) return head.replace(/^origin\//, '')
  return fallback
}

async function measureDiskSize(worktreePath: string): Promise<number | null> {
  if (!worktreePath || !fs.existsSync(worktreePath)) return null
  // du -sk gives kilobytes — portable across macOS/Linux.
  const out = await runCmd('du', ['-sk', worktreePath], 10_000)
  if (!out) return null
  const kb = parseInt(out.split(/\s+/)[0], 10)
  return Number.isFinite(kb) ? kb * 1024 : null
}

async function measureLastActivity(gitCwd: string, worktreePath: string): Promise<string | null> {
  if (!fs.existsSync(gitCwd)) return null
  const iso = await runCmd('git', ['-C', gitCwd, 'log', '-1', '--format=%cI'], 3000)
  if (iso) return iso
  // Fallback: filesystem mtime of the worktree root.
  try {
    const st = fs.statSync(worktreePath)
    return new Date(st.mtimeMs).toISOString()
  } catch {
    return null
  }
}

async function measureDirty(gitCwd: string): Promise<boolean> {
  if (!fs.existsSync(gitCwd)) return false
  const out = await runCmd('git', ['-C', gitCwd, 'status', '--porcelain'], 3000)
  return out !== null && out.length > 0
}

async function measureAheadBehind(gitCwd: string, baseBranch: string): Promise<{ ahead: number; behind: number }> {
  if (!fs.existsSync(gitCwd)) return { ahead: 0, behind: 0 }
  const out = await runCmd(
    'git',
    ['-C', gitCwd, 'rev-list', '--left-right', '--count', `origin/${baseBranch}...HEAD`],
    3000,
  )
  if (!out) return { ahead: 0, behind: 0 }
  // git prints "<behind>\t<ahead>" for `left...right` counts.
  const [behindStr, aheadStr] = out.split(/\s+/)
  const behind = parseInt(behindStr, 10)
  const ahead = parseInt(aheadStr, 10)
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  }
}

async function measurePrState(issueId: string): Promise<CleanupState['prState']> {
  try {
    const pr = await getPrForIssue(issueId)
    if (!pr?.state) return null
    const s = pr.state.toUpperCase()
    if (s === 'MERGED') return 'merged'
    if (s === 'CLOSED') return 'closed'
    if (pr.draft) return 'draft'
    return 'open'
  } catch {
    return null
  }
}

export async function computeCleanupState(issueId: string): Promise<CleanupState | null> {
  const hit = cache.get(issueId)
  if (hit && hit.expires > Date.now()) return hit.state

  const inst = readAllInstances().find((i) => i.issueId === issueId)
  if (!inst) return null

  const gitCwd = resolveGitCwd(inst)
  const fallbackBase = (inst.projectType === 'plugin-external') ? 'main' : (inst.baseRef || 'trunk')
  const baseBranch = await resolveBaseBranch(gitCwd, fallbackBase)

  // All measurements are non-blocking (execFile-based). Fan out concurrently
  // so a cold cache costs ~max(du timeout, PR REST latency) rather than the
  // sum. `du` and PR lookup dominate; the git ones return in tens of ms.
  const [diskSizeBytes, lastActivity, dirty, aheadBehind, prState] = await Promise.all([
    measureDiskSize(inst.worktreePath),
    measureLastActivity(gitCwd, inst.worktreePath),
    measureDirty(gitCwd),
    measureAheadBehind(gitCwd, baseBranch),
    measurePrState(issueId),
  ])

  const state: CleanupState = {
    diskSizeBytes,
    lastActivity,
    dirty,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    prState,
  }
  cache.set(issueId, { state, expires: Date.now() + TTL_MS })
  return state
}

export const CLEANUP_BATCH_LIMIT = 25

export async function computeCleanupStateBatch(issueIds: string[]): Promise<Record<string, CleanupState>> {
  const out: Record<string, CleanupState> = {}
  const slice = issueIds.slice(0, CLEANUP_BATCH_LIMIT)
  await Promise.all(slice.map(async (id) => {
    const s = await computeCleanupState(id)
    if (s) out[id] = s
  }))
  return out
}
