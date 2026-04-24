/**
 * Test harness for tests/integration/filter_resolvable.bats.
 *
 * Reads a JSON array of GitHubItem-like objects from stdin, invokes
 * filterResolvableIssues, writes `{kept: GitHubItem[], hidden: number}`
 * to stdout.  Pure function under test — no network, no Vue, no DOM.
 */

import { filterResolvableIssues } from '../../app/src/utils/filterResolvable.ts'
import type { GitHubItem } from '../../app/src/types'

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf-8').trim()
  if (!raw) {
    process.stdout.write(JSON.stringify({ probeError: 'empty stdin' }) + '\n')
    process.exit(2)
  }

  let items: GitHubItem[]
  try {
    items = JSON.parse(raw) as GitHubItem[]
  } catch (e) {
    process.stdout.write(JSON.stringify({ probeError: `bad input json: ${String(e)}` }) + '\n')
    process.exit(2)
  }

  try {
    const result = filterResolvableIssues(items)
    // Include only the kept issues' numbers (ordered) to make bats
    // assertions terse — full GitHubItem shape isn't needed for these
    // checks and would make jq queries noisy.
    process.stdout.write(JSON.stringify({
      keptNumbers: result.kept.map((i) => i.number),
      hidden: result.hidden,
    }) + '\n')
  } catch (e) {
    process.stdout.write(JSON.stringify({ probeError: `filterResolvableIssues threw: ${String(e)}` }) + '\n')
    process.exit(3)
  }
}

main()
