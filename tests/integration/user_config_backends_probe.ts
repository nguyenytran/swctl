/**
 * Test harness for tests/integration/user_config_backends.bats.
 *
 * Drives the pure validators (resolveEnabledBackends,
 * resolveDefaultBackend, validateAiConfig) from the swctl-ui server
 * lib so the redesigned multi-select schema is regression-guarded.
 *
 * Reads { fn, args } from stdin and prints the result as JSON on
 * stdout so bats assertions stay terse.
 *
 *   fn="resolveEnabledBackends"   args=[ <UserConfig> ]
 *   fn="resolveDefaultBackend"    args=[ <UserConfig> ]
 *   fn="validateAiConfig"         args=[ <Partial<UserConfig>>, <current> ]
 */

import {
  resolveEnabledBackends,
  resolveDefaultBackend,
  validateAiConfig,
  type UserConfig,
} from '../../app/server/lib/config.ts'

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf-8').trim()
  if (!raw) {
    process.stdout.write(JSON.stringify({ probeError: 'empty stdin' }) + '\n')
    process.exit(2)
  }

  let req: { fn: string; args: unknown[] }
  try {
    req = JSON.parse(raw) as { fn: string; args: unknown[] }
  } catch (e) {
    process.stdout.write(JSON.stringify({ probeError: `bad input: ${String(e)}` }) + '\n')
    process.exit(2)
  }

  let out: unknown
  try {
    switch (req.fn) {
      case 'resolveEnabledBackends':
        out = resolveEnabledBackends(req.args[0] as UserConfig)
        break
      case 'resolveDefaultBackend':
        out = resolveDefaultBackend(req.args[0] as UserConfig)
        break
      case 'validateAiConfig':
        out = validateAiConfig(req.args[0] as Partial<UserConfig>, req.args[1] as UserConfig)
        break
      default:
        process.stdout.write(JSON.stringify({ probeError: `unknown fn: ${req.fn}` }) + '\n')
        process.exit(2)
        return
    }
    process.stdout.write(JSON.stringify({ result: out }) + '\n')
  } catch (e) {
    process.stdout.write(JSON.stringify({ probeError: `threw: ${String(e)}` }) + '\n')
    process.exit(3)
  }
}

main()
