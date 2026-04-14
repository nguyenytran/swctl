import { ref, onUnmounted } from 'vue'

export interface ServerEvent {
  type: 'stream-start' | 'stream-done' | 'instance-changed'
  streamId?: string
  source?: 'mcp' | 'ui'
  exitCode?: number
}

const connected = ref(false)
const lastEvent = ref<ServerEvent | null>(null)

let eventSource: EventSource | null = null
let refCount = 0

function connect() {
  if (eventSource) return

  eventSource = new EventSource('/api/events')

  eventSource.addEventListener('stream-start', (e) => {
    lastEvent.value = JSON.parse(e.data)
  })

  eventSource.addEventListener('stream-done', (e) => {
    lastEvent.value = JSON.parse(e.data)
  })

  eventSource.addEventListener('instance-changed', (e) => {
    lastEvent.value = JSON.parse(e.data)
  })

  eventSource.addEventListener('open', () => {
    connected.value = true
  })

  eventSource.addEventListener('error', () => {
    connected.value = false
    // Auto-reconnect is built into EventSource
  })
}

function disconnect() {
  if (eventSource) {
    eventSource.close()
    eventSource = null
    connected.value = false
  }
}

export function useEvents() {
  // Ref-counted: connect on first use, disconnect when all unmounted
  refCount++
  if (refCount === 1) connect()

  onUnmounted(() => {
    refCount--
    if (refCount === 0) disconnect()
  })

  return { connected, lastEvent }
}
