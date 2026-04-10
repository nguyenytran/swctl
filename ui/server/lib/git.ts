import { spawn } from 'child_process'

export function listBranches(repoPath: string, query?: string, limit = 50): Promise<string[]> {
  return new Promise((resolve) => {
    // Search both local branches and remote branches, sorted by recent commit
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
    child.stderr.on('data', () => {}) // ignore errors

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

    // Timeout after 10s
    setTimeout(() => {
      child.kill()
      resolve([])
    }, 10_000)
  })
}
