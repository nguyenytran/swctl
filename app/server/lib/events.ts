export interface ServerEvent {
  type: 'stream-start' | 'stream-progress' | 'stream-done' | 'instance-changed'
  streamId?: string
  source?: 'mcp' | 'ui'
  exitCode?: number
  // stream-progress payload (drives the UI's persistent active-ops card):
  kind?: string         // 'create' | 'clean' | …
  issueId?: string      // issue id, parsed from streamId
  step?: number         // 0..total
  stepName?: string
  total?: number        // 5 for create; 0 for ops without step markers
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
