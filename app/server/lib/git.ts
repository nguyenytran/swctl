import { spawn, execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

export interface GitWorktree {
  kind: 'external'
  worktreePath: string
  branch: string | null
  head: string
  detached: boolean
  projectSlug: string
  source: 'claude' | 'codex' | 'swctl' | 'manual'
  registered: boolean
  repoPath?: string
}

function classifySource(wtPath: string): GitWorktree['source'] {
  if (wtPath.includes('/.claude/worktrees/') || wtPath.includes('/.claude/')) return 'claude'
  if (wtPath.includes('/.codex/worktrees/')) return 'codex'
  if (wtPath.includes('/_worktrees/')) return 'swctl'
  return 'manual'
}

/**
 * List all git worktrees for a registered repo, excluding the main worktree itself.
 * Uses `git worktree list --porcelain` which discovers worktrees in any location.
 */
export function listGitWorktrees(repoPath: string, projectSlug: string): Promise<GitWorktree[]> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'])

    let output = ''
    child.stdout.on('data', (d: Buffer) => { output += d })
    child.stderr.on('data', () => {})

    child.on('close', () => {
      const worktrees: GitWorktree[] = []
      const blocks = output.split(/\n\n+/).filter(Boolean)

      for (const block of blocks) {
        const lines = block.trim().split('\n')
        let wtPath = ''
        let head = ''
        let branch: string | null = null
        let detached = false
        let prunable = false

        for (const line of lines) {
          if (line.startsWith('worktree ')) wtPath = line.slice(9)
          else if (line.startsWith('HEAD ')) head = line.slice(5)
          else if (line.startsWith('branch ')) branch = line.slice(7).replace(/^refs\/heads\//, '')
          else if (line === 'detached') detached = true
          else if (line.startsWith('prunable')) prunable = true
        }

        if (!wtPath || wtPath === repoPath || prunable) continue

        worktrees.push({
          kind: 'external',
          worktreePath: wtPath,
          branch,
          head,
          detached,
          projectSlug,
          source: classifySource(wtPath),
          registered: true,
          repoPath,
        })
      }

      resolve(worktrees)
    })

    setTimeout(() => { child.kill(); resolve([]) }, 10_000)
  })
}

/**
 * Resolve a worktree's parent repo path from its .git file.
 * Worktrees have a `.git` file (not directory) containing `gitdir: /path/to/repo/.git/worktrees/name`
 */
function resolveRepoRoot(worktreePath: string): string | null {
  const gitPath = path.join(worktreePath, '.git')
  try {
    const stat = fs.statSync(gitPath)
    if (stat.isFile()) {
      // Read gitdir: line
      const content = fs.readFileSync(gitPath, 'utf8').trim()
      const match = content.match(/^gitdir:\s*(.+)/)
      if (match) {
        const gitdir = match[1]
        // gitdir is like /repo/.git/worktrees/name → go up to .git, then parent is repo root
        const dotGit = gitdir.replace(/\/worktrees\/[^/]+$/, '')
        const repoRoot = path.dirname(dotGit)
        if (fs.existsSync(path.join(repoRoot, '.git'))) {
          return repoRoot
        }
      }
    } else if (stat.isDirectory()) {
      // It's a standalone repo, not a worktree — the worktree IS the repo
      return worktreePath
    }
  } catch {}

  // Fallback: use git rev-parse
  try {
    const commonDir = execSync(`git -C "${worktreePath}" rev-parse --git-common-dir`, {
      timeout: 5000,
      encoding: 'utf8',
    }).trim()
    // commonDir is absolute path to .git dir
    const absCommon = path.isAbsolute(commonDir) ? commonDir : path.resolve(worktreePath, commonDir)
    return path.dirname(absCommon)
  } catch {}

  return null
}

/**
 * Get basic git info for a worktree path (HEAD, branch, detached state).
 */
function getWorktreeInfo(wtPath: string): { head: string; branch: string | null; detached: boolean } {
  let head = ''
  let branch: string | null = null
  let detached = false

  try {
    head = execSync(`git -C "${wtPath}" rev-parse HEAD`, {
      timeout: 5000, encoding: 'utf8',
    }).trim()
  } catch {}

  try {
    const ref = execSync(`git -C "${wtPath}" rev-parse --abbrev-ref HEAD`, {
      timeout: 5000, encoding: 'utf8',
    }).trim()
    if (ref === 'HEAD') {
      detached = true
    } else {
      branch = ref
    }
  } catch {
    detached = true
  }

  return { head, branch, detached }
}

/**
 * Scan known tool directories (~/.codex/worktrees/, ~/.claude/worktrees/) for git worktrees
 * that may belong to unregistered projects.
 */
export async function discoverToolWorktrees(
  registeredPaths: Set<string>,
  registeredSlugs: Map<string, string>,
): Promise<GitWorktree[]> {
  const home = process.env.HOME || '/root'
  // In Docker, HOME=/root but host dirs are mounted at host paths.
  // SWCTL_BROWSE_ROOT is the host user's home directory.
  const hostHome = process.env.SWCTL_BROWSE_ROOT || home
  const homes = new Set([home, hostHome])
  const toolDirs: string[] = []
  for (const h of homes) {
    toolDirs.push(path.join(h, '.codex', 'worktrees'))
    toolDirs.push(path.join(h, '.claude', 'worktrees'))
  }

  const worktrees: GitWorktree[] = []
  const seen = new Set<string>()

  for (const toolDir of toolDirs) {
    if (!fs.existsSync(toolDir)) continue

    // Recursively find directories with .git files (max depth 4)
    const gitPaths = findGitWorktrees(toolDir, 4)

    for (const wtPath of gitPaths) {
      if (seen.has(wtPath)) continue
      seen.add(wtPath)

      const repoRoot = resolveRepoRoot(wtPath)
      if (!repoRoot) continue

      // If this repo is already registered, skip — listGitWorktrees() handles it
      if (registeredPaths.has(repoRoot)) continue

      // Check if any registered project matches (path normalization)
      const registeredSlug = registeredSlugs.get(repoRoot)
      const isRegistered = !!registeredSlug

      const slug = registeredSlug || path.basename(repoRoot)
      const source = classifySource(wtPath)
      const info = getWorktreeInfo(wtPath)

      worktrees.push({
        kind: 'external',
        worktreePath: wtPath,
        branch: info.branch,
        head: info.head,
        detached: info.detached,
        projectSlug: slug,
        source,
        registered: isRegistered,
        repoPath: repoRoot,
      })
    }
  }

  return worktrees
}

/**
 * Recursively find directories that contain a .git file (worktree marker) or .git directory.
 */
function findGitWorktrees(dir: string, maxDepth: number): string[] {
  if (maxDepth <= 0) return []
  const results: string[] = []

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'vendor') continue
      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        // Check if this directory has a .git file/dir (is a worktree or repo)
        const gitPath = path.join(fullPath, '.git')
        if (fs.existsSync(gitPath)) {
          results.push(fullPath)
        } else {
          // Recurse deeper
          results.push(...findGitWorktrees(fullPath, maxDepth - 1))
        }
      }
    }
  } catch {}

  return results
}

export function listBranches(repoPath: string, query?: string, limit = 50): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn('git', [
      '-C', repoPath,
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)',
      'refs/heads/',
      'refs/remotes/origin/',
      `--count=${limit * 4}`,
    ])

    let output = ''
    child.stdout.on('data', (d: Buffer) => { output += d })
    child.stderr.on('data', () => {})

    child.on('close', () => {
      const seen = new Set<string>()
      const branches: string[] = []

      for (const raw of output.trim().split('\n')) {
        if (!raw) continue
        const name = raw.replace(/^origin\//, '')
        if (name === 'HEAD') continue
        if (seen.has(name)) continue
        seen.add(name)
        branches.push(name)
      }

      let filtered = branches
      if (query) {
        const q = query.toLowerCase()
        filtered = branches.filter(b => b.toLowerCase().includes(q))
      }

      resolve(filtered.slice(0, limit))
    })

    setTimeout(() => {
      child.kill()
      resolve([])
    }, 10_000)
  })
}
