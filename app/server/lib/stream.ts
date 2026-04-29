import { spawn, type ChildProcess } from 'child_process'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { emit } from './events.js'

const SWCTL_PATH = process.env.SWCTL_PATH || '/swctl/swctl'
const PROJECT_ROOT = process.env.PROJECT_ROOT || '/project'
const STATE_DIR = process.env.SWCTL_STATE_DIR || ''

const activeStreams = new Map<string, ChildProcess>()

/**
 * Per-stream progress snapshot.  Updated as the underlying `swctl`
 * subprocess emits `### CREATE STEP N START: <name>` markers; cleared
 * when the stream ends.  Drives /api/operations and the global
 * `stream-progress` events the UI listens to for the persistent
 * "active operations" card.
 *
 * Step is 0 when the stream has started but no marker has fired yet
 * (e.g., during arg parsing / early bash setup before pre-flight).
 * Total is whatever the stream's natural step count is — currently 5
 * for `create` (preflight → worktree → sync → provision → frontend);
 * other commands (clean, refresh, switch) just stay at 0/0.
 */
interface StreamProgress {
  streamId: string
  /** Operation kind parsed from streamId prefix — 'create', 'clean', etc. */
  kind: string
  /** Issue id parsed from streamId suffix; '' for non-issue ops. */
  issueId: string
  step: number      // 0..total
  stepName: string  // e.g. "Sync"
  total: number     // 5 for create, 0 for non-stepped ops
  startedAt: number
}
const activeProgress = new Map<string, StreamProgress>()

export function isStreamActive(id: string): boolean {
  return activeStreams.has(id)
}

export function cancelStream(streamId: string): boolean {
  const child = activeStreams.get(streamId)
  if (!child) return false
  child.kill()
  activeStreams.delete(streamId)
  activeProgress.delete(streamId)
  return true
}

/**
 * Snapshot of every operation currently in flight, sorted by start
 * time (most recent first).  Used by /api/operations on initial UI
 * load — the live `stream-progress` events drive incremental updates
 * after that.
 */
export function listActiveOperations(): StreamProgress[] {
  return Array.from(activeProgress.values()).sort((a, b) => b.startedAt - a.startedAt)
}

export function streamSwctl(c: Context, args: string[], streamId: string, onAbort?: () => void, source?: 'mcp' | 'ui') {
  // If a previous stream exists, check if it's still alive
  const existing = activeStreams.get(streamId)
  if (existing) {
    if (existing.exitCode !== null || existing.killed) {
      // Process already exited — stale entry
      activeStreams.delete(streamId)
    } else {
      // Check if process is actually still running
      try {
        process.kill(existing.pid!, 0)
        // Process is alive — reject
        return c.json({ error: `Operation already in progress for '${streamId}'` }, 409)
      } catch {
        // Process is dead but not cleaned up
        activeStreams.delete(streamId)
      }
    }
  }

  const startTime = Date.now()
  const child = spawn('bash', [SWCTL_PATH, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, SWCTL_STATE_DIR: STATE_DIR, TERM: 'dumb' },
    // Explicitly set stdio to prevent inheriting all parent FDs.
    // Without this, each child inherits the node server's open FDs (SSE connections,
    // HTTP sockets, file watchers), causing FD exhaustion when running 4+ creates in parallel.
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  activeStreams.set(streamId, child)
  // Seed the per-stream progress snapshot.  step/stepName start empty
  // and get filled in as the bash subprocess emits CREATE STEP markers.
  // streamId is by convention "<kind>:<issueId>" — split for the UI.
  const colonIdx = streamId.indexOf(':')
  const kind = colonIdx > 0 ? streamId.slice(0, colonIdx) : streamId
  const issueId = colonIdx > 0 ? streamId.slice(colonIdx + 1) : ''
  const total = kind === 'create' ? 5 : 0  // only create is currently markered
  activeProgress.set(streamId, {
    streamId,
    kind,
    issueId,
    step: 0,
    stepName: '',
    total,
    startedAt: startTime,
  })
  emit({ type: 'stream-start', streamId, source })

  const cleanup = () => {
    activeStreams.delete(streamId)
    activeProgress.delete(streamId)
  }

  return streamSSE(c, async (stream) => {
    const sendEvent = async (event: string, data: object) => {
      try {
        await stream.writeSSE({ event, data: JSON.stringify(data) })
      } catch {}
    }

    // Regex matches `### CREATE STEP N START: <name>` lines emitted
    // by `swctl create`.  We update the per-stream progress snapshot
    // and broadcast a `stream-progress` event to /api/events listeners
    // (for the UI's persistent active-operations card).
    const CREATE_STEP_RE = /^###\s*CREATE\s+STEP\s+(\d)\s+START\s*:?\s*(.*)$/i

    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line) continue
        sendEvent('log', { line, ts: Date.now() })

        const m = line.match(CREATE_STEP_RE)
        if (m) {
          const prog = activeProgress.get(streamId)
          if (prog) {
            prog.step = parseInt(m[1], 10)
            prog.stepName = m[2].trim()
            emit({
              type: 'stream-progress',
              streamId,
              kind: prog.kind,
              issueId: prog.issueId,
              step: prog.step,
              stepName: prog.stepName,
              total: prog.total,
            })
          }
        }
      }
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    stream.onAbort(() => {
      cleanup()
      child.kill()
      if (onAbort) onAbort()
    })

    await new Promise<void>((resolve) => {
      child.on('close', (code) => {
        cleanup()
        const exitCode = code || 0
        emit({ type: 'stream-done', streamId, source, exitCode })
        emit({ type: 'instance-changed' })
        sendEvent('done', { exitCode, elapsed: Date.now() - startTime })
          .then(resolve)
      })

      child.on('error', (err) => {
        cleanup()
        sendEvent('error', { message: err.message })
          .then(resolve)
      })
    })
  })
}

export function streamCommand(c: Context, cwd: string, command: string, streamId: string) {
  const existing = activeStreams.get(streamId)
  if (existing) {
    if (existing.exitCode !== null || existing.killed) {
      activeStreams.delete(streamId)
    } else {
      try {
        process.kill(existing.pid!, 0)
        return c.json({ error: `Operation already in progress for '${streamId}'` }, 409)
      } catch {
        activeStreams.delete(streamId)
      }
    }
  }

  const startTime = Date.now()
  const child = spawn('bash', ['-c', command], {
    cwd,
    env: { ...process.env, TERM: 'dumb', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  activeStreams.set(streamId, child)

  const cleanup = () => { activeStreams.delete(streamId) }

  return streamSSE(c, async (stream) => {
    const sendEvent = async (event: string, data: object) => {
      try {
        await stream.writeSSE({ event, data: JSON.stringify(data) })
      } catch {}
    }

    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line) sendEvent('log', { line, ts: Date.now() })
      }
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    stream.onAbort(() => {
      cleanup()
      child.kill()
    })

    await new Promise<void>((resolve) => {
      child.on('close', (code) => {
        cleanup()
        sendEvent('done', { exitCode: code || 0, elapsed: Date.now() - startTime })
          .then(resolve)
      })

      child.on('error', (err) => {
        cleanup()
        sendEvent('error', { message: err.message })
          .then(resolve)
      })
    })
  })
}

/**
 * Like streamCommand, but takes an explicit binary + args array instead of a
 * shell command string. Preferred when arguments contain shell-unsafe chars
 * (URLs, quoted phrases). Optionally accepts an env override.
 */
export function streamSpawn(
  c: Context,
  cwd: string,
  cmd: string,
  args: string[],
  streamId: string,
  opts?: { env?: NodeJS.ProcessEnv },
) {
  const existing = activeStreams.get(streamId)
  if (existing) {
    if (existing.exitCode !== null || existing.killed) {
      activeStreams.delete(streamId)
    } else {
      try {
        process.kill(existing.pid!, 0)
        return c.json({ error: `Operation already in progress for '${streamId}'` }, 409)
      } catch {
        activeStreams.delete(streamId)
      }
    }
  }

  const startTime = Date.now()
  const child = spawn(cmd, args, {
    cwd,
    env: opts?.env
      ? { ...process.env, ...opts.env, TERM: 'dumb', GIT_TERMINAL_PROMPT: '0' }
      : { ...process.env, TERM: 'dumb', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  activeStreams.set(streamId, child)

  const cleanup = () => { activeStreams.delete(streamId) }

  return streamSSE(c, async (stream) => {
    const sendEvent = async (event: string, data: object) => {
      try {
        await stream.writeSSE({ event, data: JSON.stringify(data) })
      } catch {}
    }

    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line) sendEvent('log', { line, ts: Date.now() })
      }
    }

    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)

    stream.onAbort(() => {
      cleanup()
      child.kill()
    })

    await new Promise<void>((resolve) => {
      child.on('close', (code) => {
        cleanup()
        sendEvent('done', { exitCode: code || 0, elapsed: Date.now() - startTime })
          .then(resolve)
      })

      child.on('error', (err) => {
        cleanup()
        sendEvent('error', { message: err.message })
          .then(resolve)
      })
    })
  })
}

export function spawnSwctl(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [SWCTL_PATH, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, SWCTL_STATE_DIR: STATE_DIR, TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout!.on('data', (d: Buffer) => { output += d })
    child.stderr!.on('data', (d: Buffer) => { output += d })
    child.on('close', (code) => {
      resolve({ ok: code === 0, output: output.trim() })
    })
  })
}
