import { spawn, type ChildProcess } from 'child_process'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'

const SWCTL_PATH = process.env.SWCTL_PATH || '/swctl/swctl'
const PROJECT_ROOT = process.env.PROJECT_ROOT || '/project'
const STATE_DIR = process.env.SWCTL_STATE_DIR || ''

const activeStreams = new Map<string, ChildProcess>()

export function isStreamActive(id: string): boolean {
  return activeStreams.has(id)
}

export function cancelStream(streamId: string): boolean {
  const child = activeStreams.get(streamId)
  if (!child) return false
  child.kill()
  activeStreams.delete(streamId)
  return true
}

export function streamSwctl(c: Context, args: string[], streamId: string, onAbort?: () => void) {
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
      if (onAbort) onAbort()
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

export function spawnSwctl(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [SWCTL_PATH, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, SWCTL_STATE_DIR: STATE_DIR, TERM: 'dumb' },
    })
    let output = ''
    child.stdout.on('data', (d) => { output += d })
    child.stderr.on('data', (d) => { output += d })
    child.on('close', (code) => {
      resolve({ ok: code === 0, output: output.trim() })
    })
  })
}
