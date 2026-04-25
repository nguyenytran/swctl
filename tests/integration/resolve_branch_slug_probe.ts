/**
 * Test harness for tests/integration/resolve_branch_slug.bats.
 *
 * Reads a single string title from stdin, invokes slugifyIssueTitle,
 * writes the slug as plain text (no quoting) on stdout.  Pure function
 * — no I/O beyond stdin/stdout.
 */

import { slugifyIssueTitle } from '../../app/server/lib/resolve.ts'

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  const title = Buffer.concat(chunks).toString('utf-8').replace(/\n+$/, '')
  process.stdout.write(slugifyIssueTitle(title))
}

main()
