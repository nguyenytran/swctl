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
    // `opts` is read from SWCTL_FILTER_OPTS so the bats tests can
    // override onlyBug without changing the stdin shape.
    let opts: Parameters<typeof filterResolvableIssues>[1] = {}
    const rawOpts = process.env.SWCTL_FILTER_OPTS
    if (rawOpts) {
      try { opts = JSON.parse(rawOpts) } catch {}
    }
    const result = filterResolvableIssues(items, opts)
    process.stdout.write(JSON.stringify({
      keptNumbers: result.kept.map((i) => i.number),
      hidden: result.hidden,
      hiddenByLinkedPr: result.hiddenByLinkedPr,
      hiddenByType: result.hiddenByType,
    }) + '\n')
  } catch (e) {
    process.stdout.write(JSON.stringify({ probeError: `filterResolvableIssues threw: ${String(e)}` }) + '\n')
    process.exit(3)
  }
}

main()
