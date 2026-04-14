export interface ServerEvent {
  type: 'stream-start' | 'stream-done' | 'instance-changed'
  streamId?: string
  source?: 'mcp' | 'ui'
  exitCode?: number
}

type Listener = (event: ServerEvent) => void

const listeners = new Set<Listener>()

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function emit(event: ServerEvent): void {
  for (const fn of listeners) {
    try { fn(event) } catch {}
  }
}
