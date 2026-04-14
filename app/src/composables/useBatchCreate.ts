import { ref, computed, watch, triggerRef, onMounted, onUnmounted } from 'vue'
import { useStream } from './useStream'
import { buildCreateUrl, preflight, fetchSystemInfo, previewCreate } from '@/api'
import type { BatchJobStatus, StreamEvent, StreamDone, PreviewCreateResult } from '@/types'

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

type PreflightStatus = 'idle' | 'checking' | 'valid' | 'warning' | 'error'

interface BatchJobData {
  id: string
  issue: string
  branch: string
  plugin: string
  deps: string
  status: BatchJobStatus
  progress: number  // 0-100
  progressLabel: string
  // Pre-flight validation
  preflightStatus: PreflightStatus
  preflightErrors: string[]
  preflightWarnings: string[]
  // Smart create preview (step plan)
  preview: PreviewCreateResult | null
  // Timing
  startedAt: number
  finishedAt: number
}

let jobCounter = 0

export function useBatchCreate() {
  const jobs = ref<BatchJobData[]>([])
  // Streams stored OUTSIDE reactivity so Vue doesn't auto-unwrap their nested refs
  const streams = new Map<string, ReturnType<typeof useStream>>()

  const selectedJobId = ref<string | null>(null)
  const isStarted = ref(false)
  const concurrency = ref(2)
  const concurrencyAutoDetected = ref(false)
  // Stagger delay between job starts (seconds) to avoid resource contention
  // When heavy phases (composer install, npm builds) overlap, all jobs slow down.
  // Staggering spreads the load so each job gets dedicated resources during its heavy phase.
  const staggerDelay = ref(30)

  // Batch timing
  const batchStartedAt = ref(0)
  const batchFinishedAt = ref(0)

  let _project = ''
  let _mode = ''

  // --- Auto-detect concurrency on mount ---
  onMounted(async () => {
    try {
      const info = await fetchSystemInfo()
      concurrency.value = info.suggestedConcurrency
      concurrencyAutoDetected.value = true
      // Auto-set stagger based on available resources: more cores = less stagger needed
      staggerDelay.value = info.suggestedConcurrency >= 3 ? 30 : 20
    } catch {
      // Keep default of 2
    }
  })

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
  const isValidating = computed(() => jobs.value.some(j => j.preflightStatus === 'checking'))
  const hasPreflightErrors = computed(() => jobs.value.some(j => j.preflightStatus === 'error'))

  // Batch elapsed time
  const batchElapsed = computed(() => {
    if (!batchStartedAt.value) return 0
    const end = batchFinishedAt.value || Date.now()
    return Math.floor((end - batchStartedAt.value) / 1000)
  })

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
      preflightStatus: 'idle',
      preflightErrors: [],
      preflightWarnings: [],
      preview: null,
      startedAt: 0,
      finishedAt: 0,
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
    batchStartedAt.value = 0
    batchFinishedAt.value = 0
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

  // --- Pre-flight validation ---
  async function validateAll(project: string, mode: string): Promise<boolean> {
    const pending = jobs.value.filter(j => j.status === 'pending')
    if (pending.length === 0) return true

    // Set all to checking
    for (const job of pending) {
      job.preflightStatus = 'checking'
      job.preflightErrors = []
      job.preflightWarnings = []
    }
    triggerRef(jobs)

    // Run all preflight checks in parallel
    const results = await Promise.allSettled(
      pending.map(async (job) => {
        const branch = job.branch || (mode === 'dev' ? `feature/${job.issue}` : '')
        const result = await preflight({
          issue: job.issue,
          project,
          branch,
          mode,
        })
        return { jobId: job.id, result }
      })
    )

    let hasErrors = false
    for (const r of results) {
      if (r.status === 'rejected') continue
      const { jobId, result } = r.value
      const job = jobs.value.find(j => j.id === jobId)
      if (!job) continue

      job.preflightErrors = result.errors
      job.preflightWarnings = result.warnings

      if (result.errors.length > 0) {
        job.preflightStatus = 'error'
        hasErrors = true
      } else if (result.warnings.length > 0) {
        job.preflightStatus = 'warning'
      } else {
        job.preflightStatus = 'valid'
      }
    }
    triggerRef(jobs)
    return !hasErrors
  }

  async function startNext() {
    if (runningCount.value >= concurrency.value) return
    const nextJob = jobs.value.find(j => j.status === 'pending')
    if (!nextJob) return

    const stream = streams.get(nextJob.id)
    if (!stream) return

    updateJobStatus(nextJob.id, 'running')
    nextJob.startedAt = Date.now()

    const branch = nextJob.branch || ''

    // Auto-preview: analyze branch diff to show what steps will run
    try {
      const preview = await previewCreate({
        issue: nextJob.issue,
        branch: branch || undefined,
        project: _project || undefined,
        mode: _mode,
        plugin: nextJob.plugin || undefined,
      })
      nextJob.preview = preview
      triggerRef(jobs)
    } catch {
      // Preview is informational — don't block creation if it fails
    }

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
        job.finishedAt = Date.now()
      }
      updateJobStatus(jobId, r.exitCode === 0 ? 'success' : 'failed')
      stopWatch()
      stopProgressWatch()

      // Check if batch is fully done
      const pending = jobs.value.filter(j => j.status === 'pending').length
      const running = jobs.value.filter(j => j.status === 'running').length
      if (pending === 0 && running === 0) {
        batchFinishedAt.value = Date.now()
      }

      startNext()
    })
  }

  let staggerTimers: ReturnType<typeof setTimeout>[] = []

  async function startAll(project: string, mode: string, { skipPreflight = false } = {}) {
    _project = project
    _mode = mode

    // Run pre-flight validation first (skip on retry — jobs already passed once,
    // and partial state from failed attempt would trigger false "already exists" errors)
    if (!skipPreflight) {
      const valid = await validateAll(project, mode)
      if (!valid) return // Block start if there are errors
    }

    isStarted.value = true
    batchStartedAt.value = Date.now()
    batchFinishedAt.value = 0

    // Clear any leftover stagger timers
    for (const t of staggerTimers) clearTimeout(t)
    staggerTimers = []

    // Start first job immediately, stagger the rest to avoid resource contention.
    // Heavy phases (composer install, npm builds) overlap when all jobs start at once,
    // causing 2x-3x slowdowns. Staggering spreads the load.
    const limit = concurrency.value
    for (let i = 0; i < limit; i++) {
      if (i === 0) {
        startNext()
      } else {
        const timer = setTimeout(() => startNext(), i * staggerDelay.value * 1000)
        staggerTimers.push(timer)
      }
    }
  }

  function cancelAll() {
    // Cancel pending stagger timers
    for (const t of staggerTimers) clearTimeout(t)
    staggerTimers = []

    for (const job of jobs.value) {
      if (job.status === 'running') {
        const stream = streams.get(job.id)
        if (stream) stream.stop()
        job.finishedAt = Date.now()
        updateJobStatus(job.id, 'failed')
      }
    }
    batchFinishedAt.value = Date.now()
  }

  // --- Retry failed jobs ---
  async function retryFailed() {
    // Cancel any lingering server-side streams for failed jobs before retrying.
    // Failed processes may not have fully cleaned up yet, causing 409 "already in progress".
    const failedJobs = jobs.value.filter(j => j.status === 'failed')
    await Promise.allSettled(
      failedJobs.map(job =>
        fetch(`/api/stream/cancel?id=create:${encodeURIComponent(job.issue)}`, { method: 'POST' }).catch(() => {})
      )
    )

    for (const job of failedJobs) {
      job.status = 'pending'
      job.progress = 0
      job.progressLabel = ''
      job.preflightStatus = 'idle'
      job.preflightErrors = []
      job.preflightWarnings = []
      job.preview = null
      job.startedAt = 0
      job.finishedAt = 0
      // Reset streams
      streams.delete(job.id)
      streams.set(job.id, useStream())
    }
    triggerRef(jobs)
    if (_project && _mode) {
      // Skip preflight on retry: jobs already passed preflight the first time,
      // and partial state from the failed attempt would cause false "already exists" errors
      startAll(_project, _mode, { skipPreflight: true })
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
    concurrencyAutoDetected,
    staggerDelay,
    isStarted,
    totalCount,
    pendingCount,
    runningCount,
    successCount,
    failedCount,
    isRunning,
    allDone,
    isValidating,
    hasPreflightErrors,
    batchElapsed,
    batchStartedAt,
    batchFinishedAt,
    addJob,
    removeJob,
    clearCompleted,
    resetForNewBatch,
    parseMultilineInput,
    startAll,
    cancelAll,
    retryFailed,
  }
}
