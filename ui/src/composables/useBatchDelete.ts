import { ref, computed, watch, triggerRef, onMounted, onUnmounted } from 'vue'
import { useStream } from './useStream'
import { buildStreamUrl } from '@/api'
import type { BatchJobStatus, StreamEvent, StreamDone } from '@/types'

// Key milestones from swctl clean output, in order of appearance
const DELETE_PROGRESS_STEPS = [
  { pattern: /cleaning linked plugins|removed plugin/i, label: 'Plugins', pct: 15 },
  { pattern: /removed containers/i, label: 'Containers', pct: 30 },
  { pattern: /removed.*volumes/i, label: 'Volumes', pct: 50 },
  { pattern: /removed networks/i, label: 'Networks', pct: 60 },
  { pattern: /dropped database/i, label: 'Database', pct: 75 },
  { pattern: /removed worktree|worktree.*absent/i, label: 'Worktree', pct: 90 },
  { pattern: /cleaned issue/i, label: 'Done', pct: 100 },
]

interface DeleteJobData {
  id: string
  issueId: string
  issue: string
  hasPlugins: boolean
  status: BatchJobStatus
  progress: number
  progressLabel: string
}

let jobCounter = 0

export function useBatchDelete() {
  const jobs = ref<DeleteJobData[]>([])
  // Streams stored OUTSIDE reactivity so Vue doesn't auto-unwrap their nested refs
  const streams = new Map<string, ReturnType<typeof useStream>>()

  const selectedJobId = ref<string | null>(null)
  const isStarted = ref(false)
  const concurrency = ref(2)

  // --- beforeunload protection ---
  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (isRunning.value) {
      e.preventDefault()
      e.returnValue = 'Batch deletion is still running. Are you sure you want to leave?'
      return e.returnValue
    }
  }
  onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
  onUnmounted(() => window.removeEventListener('beforeunload', onBeforeUnload))

  // Computed stats
  const totalCount = computed(() => jobs.value.length)
  const pendingCount = computed(() => jobs.value.filter(j => j.status === 'pending').length)
  const runningCount = computed(() => jobs.value.filter(j => j.status === 'running').length)
  const successCount = computed(() => jobs.value.filter(j => j.status === 'success').length)
  const failedCount = computed(() => jobs.value.filter(j => j.status === 'failed').length)
  const isRunning = computed(() => jobs.value.some(j => j.status === 'running'))
  const allDone = computed(() => isStarted.value && pendingCount.value === 0 && runningCount.value === 0)

  function addJob(issueId: string, issue: string, hasPlugins = false) {
    const id = `del-${++jobCounter}`
    jobs.value.push({
      id,
      issueId,
      issue: issue || issueId,
      hasPlugins,
      status: 'pending',
      progress: 0,
      progressLabel: '',
    })
    streams.set(id, useStream())
    return id
  }

  function removeJob(id: string) {
    const idx = jobs.value.findIndex(j => j.id === id)
    if (idx === -1) return
    if (jobs.value[idx].status === 'running') return
    jobs.value.splice(idx, 1)
    streams.delete(id)
    if (selectedJobId.value === id) selectedJobId.value = null
  }

  function clear() {
    for (const job of jobs.value) {
      if (job.status === 'running') {
        const stream = streams.get(job.id)
        if (stream) stream.stop()
      }
    }
    jobs.value = []
    streams.clear()
    selectedJobId.value = null
    isStarted.value = false
  }

  function updateJobStatus(id: string, status: BatchJobStatus) {
    const job = jobs.value.find(j => j.id === id)
    if (job) {
      job.status = status
      triggerRef(jobs)
    }
  }

  function startNext() {
    if (runningCount.value >= concurrency.value) return
    const nextJob = jobs.value.find(j => j.status === 'pending')
    if (!nextJob) return

    const stream = streams.get(nextJob.id)
    if (!stream) return

    updateJobStatus(nextJob.id, 'running')

    const params: Record<string, string> = { issueId: nextJob.issueId }
    if (nextJob.hasPlugins) params.force = '1'
    const url = buildStreamUrl('clean', params)
    stream.start(url)

    // Auto-select the most recently started job
    selectedJobId.value = nextJob.id

    const jobId = nextJob.id

    // Watch stream lines for progress milestones
    const stopProgressWatch = watch(
      () => stream.lines.value.length,
      () => {
        const job = jobs.value.find(j => j.id === jobId)
        if (!job) return
        const lines = stream.lines.value
        const recentStart = Math.max(0, lines.length - 5)
        for (let i = recentStart; i < lines.length; i++) {
          const text = lines[i].line
          for (const step of DELETE_PROGRESS_STEPS) {
            if (step.pct > job.progress && step.pattern.test(text)) {
              job.progress = step.pct
              job.progressLabel = step.label
              triggerRef(jobs)
              break
            }
          }
        }
      },
    )

    const stopWatch = watch(stream.result, (r) => {
      if (!r) return
      const job = jobs.value.find(j => j.id === jobId)
      if (job) {
        job.progress = r.exitCode === 0 ? 100 : job.progress
        job.progressLabel = r.exitCode === 0 ? 'Done' : 'Failed'
      }
      updateJobStatus(jobId, r.exitCode === 0 ? 'success' : 'failed')
      stopWatch()
      stopProgressWatch()
      startNext()
    })
  }

  function startAll() {
    isStarted.value = true
    const limit = concurrency.value
    for (let i = 0; i < limit; i++) {
      startNext()
    }
  }

  function cancelAll() {
    for (const job of jobs.value) {
      if (job.status === 'running') {
        const stream = streams.get(job.id)
        if (stream) stream.stop()
        updateJobStatus(job.id, 'failed')
      }
    }
  }

  // Selected job helpers
  const selectedJob = computed(() => {
    if (!selectedJobId.value) return null
    return jobs.value.find(j => j.id === selectedJobId.value) || null
  })

  function getSelectedStream() {
    if (!selectedJobId.value) return null
    return streams.get(selectedJobId.value) || null
  }

  const selectedLines = computed<StreamEvent[]>(() => getSelectedStream()?.lines.value || [])
  const selectedRunning = computed(() => getSelectedStream()?.running.value || false)
  const selectedResult = computed<StreamDone | null>(() => getSelectedStream()?.result.value || null)
  const selectedStatus = computed<BatchJobStatus>(() => selectedJob.value?.status || 'pending')

  return {
    jobs,
    selectedJobId,
    selectedJob,
    selectedLines,
    selectedRunning,
    selectedResult,
    selectedStatus,
    concurrency,
    isStarted,
    totalCount,
    pendingCount,
    runningCount,
    successCount,
    failedCount,
    isRunning,
    allDone,
    addJob,
    removeJob,
    clear,
    startAll,
    cancelAll,
  }
}
