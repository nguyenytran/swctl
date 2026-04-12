import { ref, computed, watch, triggerRef, onMounted, onUnmounted } from 'vue'
import { useStream } from './useStream'
import { buildCreateUrl } from '@/api'
import type { BatchJobStatus, StreamEvent, StreamDone } from '@/types'

// Key milestones from swctl create output, in order of appearance
const PROGRESS_STEPS = [
  { pattern: /worktree.*created|worktree.*exists|attached.*branch/i, label: 'Worktree', pct: 10 },
  { pattern: /copied gitignored|synced.*\//i, label: 'Sync files', pct: 20 },
  { pattern: /generated.*\.env/i, label: 'Env config', pct: 30 },
  { pattern: /docker.*compose.*up|starting.*container/i, label: 'Containers', pct: 40 },
  { pattern: /composer install|reusing existing vendor/i, label: 'Composer', pct: 50 },
  { pattern: /npm install|pnpm install|reusing existing node_modules/i, label: 'Dependencies', pct: 60 },
  { pattern: /system install|database/i, label: 'Database', pct: 70 },
  { pattern: /bundle:dump|building.*admin|building.*storefront/i, label: 'Build assets', pct: 85 },
  { pattern: /worktree.*is ready|successfully provisioned/i, label: 'Done', pct: 100 },
]

interface BatchJobData {
  id: string
  issue: string
  branch: string
  plugin: string
  deps: string
  status: BatchJobStatus
  progress: number  // 0-100
  progressLabel: string
}

let jobCounter = 0

export function useBatchCreate() {
  const jobs = ref<BatchJobData[]>([])
  // Streams stored OUTSIDE reactivity so Vue doesn't auto-unwrap their nested refs
  const streams = new Map<string, ReturnType<typeof useStream>>()

  const selectedJobId = ref<string | null>(null)
  const isStarted = ref(false)
  const concurrency = ref(2)

  let _project = ''
  let _mode = ''

  // --- beforeunload protection ---
  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (isRunning.value) {
      e.preventDefault()
      // Modern browsers ignore custom messages but require returnValue
      e.returnValue = 'Batch creation is still running. Are you sure you want to leave?'
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

  function addJob(issue: string, branch = '', plugin = '', deps = '') {
    const id = `batch-${++jobCounter}`
    jobs.value.push({
      id,
      issue: issue.trim(),
      branch: branch.trim(),
      plugin: plugin.trim(),
      deps: deps.trim(),
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

  function clearCompleted() {
    const removed: string[] = []
    jobs.value = jobs.value.filter(j => {
      if (j.status === 'success' || j.status === 'failed') {
        removed.push(j.id)
        return false
      }
      return true
    })
    for (const id of removed) streams.delete(id)
    if (selectedJobId.value && !jobs.value.find(j => j.id === selectedJobId.value)) {
      selectedJobId.value = null
    }
  }

  function resetForNewBatch() {
    isStarted.value = false
  }

  function parseMultilineInput(text: string): Array<{ issue: string; branch: string }> {
    const results: Array<{ issue: string; branch: string }> = []
    const lines = text.split(/[\n,]/).map(l => l.trim()).filter(Boolean)
    for (const line of lines) {
      if (line.startsWith('#')) continue
      const clean = line.replace(/#.*$/, '').trim()
      if (!clean) continue
      const parts = clean.split(/\s+/)
      results.push({ issue: parts[0], branch: parts[1] || '' })
    }
    return results
  }

  function updateJobStatus(id: string, status: BatchJobStatus) {
    const job = jobs.value.find(j => j.id === id)
    if (job) {
      job.status = status
      // Trigger reactivity since we mutated a nested property
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

    const branch = nextJob.branch || ''
    const url = buildCreateUrl({
      issue: nextJob.issue,
      mode: _mode,
      branch: branch || undefined,
      project: _project || undefined,
      plugin: nextJob.plugin || undefined,
      deps: nextJob.deps || undefined,
    })
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
        // Scan recent lines (last 5) for progress patterns
        const recentStart = Math.max(0, lines.length - 5)
        for (let i = recentStart; i < lines.length; i++) {
          const text = lines[i].line
          for (const step of PROGRESS_STEPS) {
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

    // Watch stream.result (a proper Ref, not auto-unwrapped)
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

  function startAll(project: string, mode: string) {
    _project = project
    _mode = mode
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

  // Selected job helpers — get stream from map
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
    clearCompleted,
    resetForNewBatch,
    parseMultilineInput,
    startAll,
    cancelAll,
  }
}
