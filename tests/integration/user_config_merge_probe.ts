/**
 * Test harness for tests/integration/user_config_merge.bats.
 *
 * Drives `writeUserConfig` against an isolated config file per-test
 * (via SWCTL_CONFIG_FILE).  Reads a JSON payload from stdin of the
 * shape:
 *
 *   {
 *     "initial":  <UserConfig to seed on disk, or null for no file>,
 *     "patch":    <Partial<UserConfig> to pass to writeUserConfig>
 *   }
 *
 * Writes the post-write `readUserConfig()` result to stdout as JSON.
 * Bats tests assert on subpaths via jq.
 *
 * This is the only practical way to unit-test the merge logic without
 * a real JS test runner: spawn a fresh tsx process per case, point at
 * a mktemp'd config file, and inspect both the returned value and
 * what actually landed on disk.
 */

import { writeUserConfig, readUserConfig, type UserConfig } from '../../app/server/lib/config.ts'
import fs from 'fs'

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf-8').trim()
  if (!raw) {
    process.stdout.write(JSON.stringify({ probeError: 'empty stdin' }) + '\n')
    process.exit(2)
  }

  let input: { initial: UserConfig | null; patch: Partial<UserConfig> }
  try {
    input = JSON.parse(raw)
  } catch (e) {
    process.stdout.write(JSON.stringify({ probeError: `bad input json: ${String(e)}` }) + '\n')
    process.exit(2)
  }

  // Seed the file (or remove it for the "no initial" case).
  const file = process.env.SWCTL_CONFIG_FILE
  if (!file) {
    process.stdout.write(JSON.stringify({ probeError: 'SWCTL_CONFIG_FILE not set' }) + '\n')
    process.exit(2)
  }
  if (input.initial === null) {
    try { fs.unlinkSync(file) } catch {}
  } else {
    fs.mkdirSync(require('path').dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(input.initial, null, 2) + '\n')
  }

  try {
    const returnedFromWrite = writeUserConfig(input.patch)
    const reReadFromDisk = readUserConfig()
    process.stdout.write(JSON.stringify({ returned: returnedFromWrite, onDisk: reReadFromDisk }) + '\n')
  } catch (e) {
    process.stdout.write(JSON.stringify({ probeError: `writeUserConfig threw: ${String(e)}` }) + '\n')
    process.exit(3)
  }
}

main()
