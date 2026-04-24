/**
 * Test harness for tests/integration/resolve_create_args.bats.
 *
 * Reads a JSON `CreateArgsInput` from stdin, invokes buildCreateArgs,
 * writes the resulting argv as a JSON array on stdout.  Pure function
 * under test — no network, no spawn, no filesystem.
 *
 * Invoked from bats via:
 *   echo '{"issueId":"...","branchPrefix":"fix","project":null,"mode":"dev"}' \
 *     | ./node_modules/.bin/tsx tests/integration/resolve_create_args_probe.ts
 */

import { buildCreateArgs, type CreateArgsInput } from '../../app/server/lib/resolve.ts'

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf-8').trim()
  if (!raw) {
    process.stdout.write(JSON.stringify({ probeError: 'empty stdin' }) + '\n')
    process.exit(2)
  }

  let input: CreateArgsInput
  try {
    input = JSON.parse(raw) as CreateArgsInput
  } catch (e) {
    process.stdout.write(JSON.stringify({ probeError: `bad input json: ${String(e)}` }) + '\n')
    process.exit(2)
  }

  try {
    const args = buildCreateArgs(input)
    process.stdout.write(JSON.stringify(args) + '\n')
  } catch (e) {
    // buildCreateArgs should never throw on well-typed input — a throw
    // is a regression.
    process.stdout.write(JSON.stringify({ probeError: `buildCreateArgs threw: ${String(e)}` }) + '\n')
    process.exit(3)
  }
}

main()
