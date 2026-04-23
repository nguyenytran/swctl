/**
 * Test harness for tests/integration/resolve_backend_read.bats.
 *
 * Reads `{"issueId":"<id>"}` from stdin, invokes readInstanceBackend,
 * writes `{"backend":"claude"|"codex"}` to stdout.  Each test points
 * SWCTL_STATE_DIR at a fresh tmpdir and writes a fixture env file under
 * <dir>/instances/<project>/<id>.env before running the probe.
 *
 * SWCTL_STATE_DIR is read at module-load time in resolve.ts, so each
 * probe invocation must be a fresh tsx process (bats' `run bash -c`
 * already does this per @test).
 */

import { readInstanceBackend } from '../../app/server/lib/resolve.ts'

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf-8').trim()
  if (!raw) {
    process.stdout.write(JSON.stringify({ probeError: 'empty stdin' }) + '\n')
    process.exit(2)
  }

  let input: { issueId: string }
  try {
    input = JSON.parse(raw) as { issueId: string }
  } catch (e) {
    process.stdout.write(JSON.stringify({ probeError: `bad input json: ${String(e)}` }) + '\n')
    process.exit(2)
  }

  try {
    const backend = readInstanceBackend(input.issueId)
    process.stdout.write(JSON.stringify({ backend }) + '\n')
  } catch (e) {
    process.stdout.write(JSON.stringify({ probeError: `readInstanceBackend threw: ${String(e)}` }) + '\n')
    process.exit(3)
  }
}

main()
