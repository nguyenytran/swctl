import { ref } from 'vue'
import type { StreamEvent, StreamDone } from '@/types'

export function useStream() {
  const lines = ref<StreamEvent[]>([])
  const running = ref(false)
  const result = ref<StreamDone | null>(null)
  let eventSource: EventSource | null = null

  function start(url: string) {
    // Close any existing stream first
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }

    lines.value = []
    result.value = null
    running.value = true

    eventSource = new EventSource(url)

    eventSource.addEventListener('log', (e) => {
      const data = JSON.parse(e.data) as StreamEvent
      lines.value.push(data)
    })

    eventSource.addEventListener('done', (e) => {
      const data = JSON.parse(e.data) as StreamDone
      result.value = data
      running.value = false
      eventSource?.close()
      eventSource = null
    })

    eventSource.addEventListener('error', (e) => {
      // SSE connection closed by server after done event
      if (!running.value) return
      running.value = false
      eventSource?.close()
      eventSource = null
    })
  }

  function stop() {
    eventSource?.close()
    eventSource = null
    running.value = false
  }

  return { lines, running, result, start, stop }
}
