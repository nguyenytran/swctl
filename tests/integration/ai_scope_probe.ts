/**
 * Test harness for tests/integration/ai_scope.bats.
 *
 * Reads a JSON `AiScopeInput` from stdin, invokes detectScopeWithAI,
 * writes the resulting `AiScopeDecision` as one JSON line to stdout.
 * Never throws — on unexpected errors emits
 *   {"probeError":"<message>"}
 * so the bats test can assert on it instead of a non-zero exit.
 *
 * Invoked from bats via:
 *   echo '{"issueTitle":"..", ...}' \
 *     | SWCTL_CLAUDE_BIN=/tmp/stub ./node_modules/.bin/tsx \
 *         tests/integration/ai_scope_probe.ts
 */

import { detectScopeWithAI, type AiScopeInput } from '../../app/server/lib/ai-scope.ts'

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf-8').trim()
  if (!raw) {
    process.stdout.write(JSON.stringify({ probeError: 'empty stdin' }) + '\n')
    process.exit(2)
  }

  let input: AiScopeInput
  try {
    input = JSON.parse(raw) as AiScopeInput
  } catch (e) {
    process.stdout.write(JSON.stringify({ probeError: `bad input json: ${String(e)}` }) + '\n')
    process.exit(2)
  }

  try {
    const result = await detectScopeWithAI(input)
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch (e) {
    // detectScopeWithAI should never throw — this is a regression guard.
    process.stdout.write(JSON.stringify({ probeError: `detect threw: ${String(e)}` }) + '\n')
    process.exit(3)
  }
}

main()
