/**
 * Test harness for tests/integration/resolve_spawn_args.bats.
 *
 * Reads a JSON `SpawnArgsInput` from stdin, invokes buildSpawnArgs,
 * writes the resulting `{bin, args}` as JSON on stdout.  Pure function
 * under test — no network, no spawn, no filesystem.
 *
 * Invoked from bats via:
 *   echo '{"backend":"codex","prompt":"...","sessionId":"...",
 *          "worktreePath":"/tmp/w","allowedTools":""}' \
 *     | ./node_modules/.bin/tsx tests/integration/resolve_spawn_args_probe.ts
 */

import { buildSpawnArgs, type SpawnArgsInput } from '../../app/server/lib/resolve.ts'

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf-8').trim()
  if (!raw) {
    process.stdout.write(JSON.stringify({ probeError: 'empty stdin' }) + '\n')
    process.exit(2)
  }

  let input: SpawnArgsInput
  try {
    input = JSON.parse(raw) as SpawnArgsInput
  } catch (e) {
    process.stdout.write(JSON.stringify({ probeError: `bad input json: ${String(e)}` }) + '\n')
    process.exit(2)
  }

  try {
    const result = buildSpawnArgs(input)
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch (e) {
    process.stdout.write(JSON.stringify({ probeError: `buildSpawnArgs threw: ${String(e)}` }) + '\n')
    process.exit(3)
  }
}

main()
