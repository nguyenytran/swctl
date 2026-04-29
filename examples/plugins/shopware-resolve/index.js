  /**
 * shopware-resolve — swctl plugin
 *
 * Integrates the "shopware-resolve" Claude Code skill with swctl:
 *   - Route   : /resolve (top-nav)  — form to submit an issue URL/number
 *   - Widget  : dashboard-bottom    — recent resolve runs with status
 *   - Action  : instance row        — "Resolve with Claude" pre-fills the form
 *
 * The plugin talks to the server-side `/api/skill/resolve/stream` SSE endpoint
 * which spawns Claude Code non-interactively with `/shopware-resolve <issue>`.
 */

// ---------- Shared state (module-level so widgets can refresh) ----------

let runsPoller = null
async function fetchRuns() {
  try {
    const res = await fetch('/api/skill/resolve/runs')
    return res.ok ? await res.json() : []
  } catch {
    return []
  }
}

// ---------- Backend (Claude / Codex) selection ----------
//
// The user's last AI-backend choice persists across reloads via
// localStorage.  Initial value falls back to `claude` to match the
// server-side default.  Eventually this should also seed from
// `/api/user-config` (.ai.defaultBackend) — but localStorage wins
// once the user has picked something explicitly in this UI.
//
// IMPORTANT: the user-facing radio in this plugin's create form is
// what actually drives spawn.  Without passing `?backend=<value>` in
// the stream URL, the server falls back to claude regardless of any
// other config — which is exactly the bug a previous attempt left
// in place.

const BACKEND_LS_KEY = 'swctl.resolve.backend'
function getBackend() {
  try {
    const v = localStorage.getItem(BACKEND_LS_KEY)
    return v === 'codex' ? 'codex' : 'claude'
  } catch { return 'claude' }
}
function setBackend(v) {
  try { localStorage.setItem(BACKEND_LS_KEY, v === 'codex' ? 'codex' : 'claude') } catch {}
}

// ---------- Stream helper (used by route + action) ----------

function startStream(issue, project, mode, out, onDone) {
  const params = new URLSearchParams()
  params.set('issue', issue)
  if (project) params.set('project', project)
  if (mode) params.set('mode', mode)
  // Forward the user-selected backend.  Server's `coerceBackend`
  // treats any other value (or absent) as 'claude', so omitting it
  // when the user picked Codex would silently spawn Claude — the
  // exact bug PR #6's spawn fix exposed.
  const backend = getBackend()
  if (backend && backend !== 'claude') params.set('backend', backend)

  const url = `/api/skill/resolve/stream?${params.toString()}`
  // Surface the URL we're about to hit, including any backend param,
  // so a "I picked Codex but Claude ran" mismatch is debuggable
  // without docker exec'ing into the container.
  appendLine(out, `[client] opening stream: ${url}`)
  const es = new EventSource(url)

  es.addEventListener('log', (e) => {
    try {
      const data = JSON.parse(e.data)
      renderLine(out, data.line)
    } catch {}
  })

  es.addEventListener('done', async (e) => {
    let exitCode = 0
    try {
      exitCode = JSON.parse(e.data).exitCode ?? 0
    } catch {}
    es.close()
    appendLine(out, `\n─── Done (exit ${exitCode}) ───`, exitCode === 0 ? 'ok' : 'err')
    // Tell the server to finalise the run record so widgets refresh
    try {
      await fetch('/api/skill/resolve/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue, exitCode }),
      })
    } catch {}
    if (onDone) onDone(exitCode)
  })

  es.addEventListener('error', (e) => {
    let msg = 'Stream error'
    try { msg = JSON.parse(e.data).message || msg } catch {}
    appendLine(out, `ERROR: ${msg}`, 'err')
    es.close()
    if (onDone) onDone(1)
  })

  return es
}

/**
 * Retry path for "create failed before the resolve agent could spawn":
 * clean the half-built worktree, then re-trigger the whole resolve flow
 * from scratch.  The bash side already has a "STATUS=failed → resume"
 * code path inside cmd_create, but partial creates leave fragmented
 * state that's simpler to wipe than to continue from — DB might be
 * half-cloned, container might be down, vendor copy might be partial.
 * One Retry button that does the safe thing is clearer UX than a
 * granular menu.
 *
 * Called by the create-failure card's onclick.  Returns a promise so
 * the caller can re-enable the button on error.
 */
async function retryAfterCreateFailure(issue, project, mode, out, stepInfo, updateStepper, resultEl, onDone, updateCreateStepper, issueId) {
  appendLine(out, `\n─── Retry: cleaning failed instance ${issueId} ───`, 'log')

  // Stream the clean output into the same console so the user sees
  // what's being torn down.  When the clean stream finishes (success
  // or failure), we re-run the resolve.
  await new Promise((resolve, reject) => {
    const cleanUrl = `/api/stream/clean?issueId=${encodeURIComponent(issueId)}&force=1`
    const ces = new EventSource(cleanUrl)
    ces.addEventListener('log', (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.line) appendLine(out, data.line, 'log')
      } catch {}
    })
    ces.addEventListener('done', (e) => {
      let exitCode = 0
      try { exitCode = (JSON.parse(e.data) || {}).exitCode ?? 0 } catch {}
      ces.close()
      if (exitCode === 0) {
        resolve()
      } else {
        // Even on clean failure we proceed to retry — clean's idempotent
        // and a stuck-in-half-state instance is what we're trying to
        // unstick.  Worst case the next swctl create surfaces the same
        // error again.
        appendLine(out, `[clean] exited with code ${exitCode} — proceeding to retry anyway`, 'err')
        resolve()
      }
    })
    ces.addEventListener('error', () => {
      ces.close()
      reject(new Error('clean stream errored'))
    })
  })

  appendLine(out, '\n─── Clean done; re-running resolve ───\n', 'log')
  // Same args as the original run.  startStreamWithSteps will go
  // through create + resolve again from scratch.
  startStreamWithSteps(issue, project, mode, out, stepInfo, updateStepper, resultEl, onDone, updateCreateStepper)
}

function startStreamWithSteps(issue, project, mode, out, stepInfo, updateStepper, resultEl, onDone, updateCreateStepper) {
  // Lazy permission request — first resolve in a fresh browser pops
  // the OS prompt; subsequent runs are no-ops.  See notifyResolveDone
  // for why and when notifications fire.
  maybeRequestNotificationPermission()

  const params = new URLSearchParams()
  params.set('issue', issue)
  if (project) params.set('project', project)
  if (mode) params.set('mode', mode)
  const backend = getBackend()
  if (backend && backend !== 'claude') params.set('backend', backend)

  const url = `/api/skill/resolve/stream?${params.toString()}`
  appendLine(out, `[client] opening stream: ${url}`)
  // Capture start time so the done handler can report duration in
  // the OS notification body.  The server's `elapsed` field arrives
  // alongside `done`, but a client-side timer is robust against the
  // server-side timing being slightly off (we want what the user
  // experienced as wall time, not what the server measured).
  const streamStartedAt = Date.now()
  const es = new EventSource(url)

  // Wire the manual-stop button.  The button is in the static markup
  // (id=sr-stop-btn) and starts hidden; we show it now and tear it
  // down on done/error.  `wasManuallyCancelled` is the local flag the
  // done handler reads to render the "you stopped this" card variant
  // instead of the generic failure card.
  let wasManuallyCancelled = false
  const stopBtn = document.getElementById('sr-stop-btn')
  const onStopClick = async () => {
    if (!confirm('Stop this resolve run?  The agent process will be terminated; partial progress + transcript are preserved.')) return
    stopBtn.disabled = true
    stopBtn.textContent = 'Stopping…'
    wasManuallyCancelled = true
    appendLine(out, '\n─── Manual stop requested ───', 'log')
    try {
      // Encode the streamId — for resolve streams it's `resolve:<full-issue-url-or-number>`.
      const streamId = `resolve:${issue}`
      await fetch(`/api/stream/cancel?id=${encodeURIComponent(streamId)}`, { method: 'POST' })
    } catch (err) {
      appendLine(out, `[stop] cancel request failed: ${err && err.message || err}`, 'err')
    }
    // The agent gets SIGTERM and the done handler fires shortly.
    // No need to close `es` here — the close on the server side
    // ends the SSE stream which fires our `done` listener, which
    // does the cleanup.
  }
  if (stopBtn) {
    stopBtn.disabled = false
    stopBtn.textContent = '🛑 Stop'
    stopBtn.style.display = ''
    stopBtn.addEventListener('click', onStopClick)
  }
  let currentStep = 1
  // No-op fallback so callers that haven't been updated yet still work.
  const updCreate = typeof updateCreateStepper === 'function' ? updateCreateStepper : () => {}

  // Phase tracking — distinguishes "create failed" from "resolve failed"
  // so the failure card can render the right buttons (Retry vs Resume).
  // We're in create phase until the first resolve `### STEP N` marker
  // arrives.  lastCreateStep + lastCreateStepName feed the failure-card
  // title when the failure is during create.
  let inCreatePhase = true
  let lastCreateStep = 0
  let lastCreateStepName = ''

  const stepNames = {
    1: 'Verify the issue',
    2: 'Find root cause',
    3: 'Implement the fix',
    4: 'Independent review',
    5: 'Provision environment',
    6: 'Test and validate',
    7: 'Prepare for merge',
    8: 'Decision-ready output',
  }

  const createStepNames = {
    1: 'Pre-flight',
    2: 'Worktree',
    3: 'Sync',
    4: 'Provision',
    5: 'Frontend',
  }

  // Coverage tracking: record which steps actually started/ended so we can
  // surface gaps to the user after the run completes.
  const stepsStarted = new Set()
  const stepsEnded = new Set()
  const createStepsEnded = new Set()

  es.addEventListener('log', (e) => {
    try {
      const data = JSON.parse(e.data)
      const line = data.line || ''
      renderLine(out, line)

      // CREATE STEP markers from `swctl create` — separate phase from
      // the resolve workflow.  Match BEFORE the resolve regex so the
      // `STEP` substring inside `CREATE STEP` doesn't false-match.
      const createStartMatch = line.match(/###\s*CREATE\s+STEP\s+(\d)\s+START/i)
      const createEndMatch = line.match(/###\s*CREATE\s+STEP\s+(\d)\s+END/i)
      if (createStartMatch) {
        const n = parseInt(createStartMatch[1])
        if (n >= 1 && n <= 5) {
          lastCreateStep = n
          lastCreateStepName = createStepNames[n] || ''
          updCreate(n, 'active')
          stepInfo.textContent = `Creating worktree — Step ${n}/5: ${lastCreateStepName}`
        }
        return  // don't fall through to resolve regex (would never match anyway, but explicit)
      } else if (createEndMatch) {
        const n = parseInt(createEndMatch[1])
        if (n >= 1 && n <= 5) {
          createStepsEnded.add(n)
          updCreate(n, 'done')
          if (createStepsEnded.size === 5) {
            // Whole create phase done — fade the create stepper so the
            // resolve workflow stepper takes visual focus.
            updCreate(0, 'complete')
            inCreatePhase = false  // failures from here on are resolve failures
          }
        }
        return
      }

      // Strict markers emitted by Claude under our instruction:
      //   ### STEP <N> START: <name>
      //   ### STEP <N> END
      const startMatch = line.match(/###\s*STEP\s+(\d)\s+START/i)
      const endMatch = line.match(/###\s*STEP\s+(\d)\s+END/i)
      // The `CREATE STEP` and `STEP` regexes both match `### CREATE
      // STEP …` (the `STEP` regex matches the `STEP` substring of
      // `CREATE STEP`).  CREATE-STEP lines were already handled +
      // returned above, but if a line happens to contain BOTH (unlikely
      // but defensive), the `isCreateLine` guard blocks the resolve
      // path so it doesn't double-count.
      const isCreateLine = /CREATE\s+STEP/i.test(line)
      if (startMatch && !isCreateLine) {
        const n = parseInt(startMatch[1])
        if (n >= 1 && n <= 8) {
          stepsStarted.add(n)
          inCreatePhase = false  // we're past create, into the resolve workflow
          if (n >= currentStep) {
            currentStep = n
            updateStepper(currentStep, 'active')
            stepInfo.textContent = `Step ${currentStep}: ${stepNames[currentStep] || ''}`
          }
        }
      } else if (endMatch && !isCreateLine) {
        const n = parseInt(endMatch[1])
        if (n >= 1 && n <= 8) {
          stepsEnded.add(n)
          updateStepper(n, 'done')
        }
      } else if (!isCreateLine) {
        // Fallback: legacy loose matcher for older runs without markers.
        const legacy = line.match(/(?:^|\s)Step\s+(\d)\b/i)
        if (legacy) {
          const n = parseInt(legacy[1])
          if (n > currentStep && n <= 8) {
            currentStep = n
            updateStepper(currentStep, 'active')
            stepInfo.textContent = `Step ${currentStep}: ${stepNames[currentStep] || ''}`
          }
        }
      }
    } catch {}
  })

  // Live token-usage badge.  Updates from the server's throttled
  // `tokens` events (every 50K tokens or 2s during a run, plus a
  // final emit alongside `done`).  Color-codes by % budget used.
  const tokensBadge = el.querySelector('#sr-tokens-badge')
  let lastBudgetExceeded = false
  es.addEventListener('tokens', (e) => {
    try {
      const data = JSON.parse(e.data)
      const total = Number(data.total) || 0
      const budget = data.budget == null ? null : Number(data.budget)
      lastBudgetExceeded = budget !== null && total > budget
      if (!tokensBadge) return
      tokensBadge.style.display = ''
      const fmtTok = (n) => n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M'
                          : n >= 1_000 ? (n / 1_000).toFixed(0) + 'K'
                          : String(n)
      if (budget === null) {
        tokensBadge.textContent = `🪙 ${fmtTok(total)} (no cap)`
        tokensBadge.style.color = '#9ca3af'
        tokensBadge.style.borderColor = '#374151'
      } else {
        const pct = Math.round(100 * total / budget)
        let color = '#34d399', border = '#065f46'  // green <50%
        if (pct >= 80) { color = '#f87171'; border = '#7f1d1d' }
        else if (pct >= 50) { color = '#fbbf24'; border = '#b45309' }
        tokensBadge.textContent = `🪙 ${fmtTok(total)} / ${fmtTok(budget)} (${pct}%)`
        tokensBadge.style.color = color
        tokensBadge.style.borderColor = border
      }
    } catch {}
  })

  es.addEventListener('done', async (e) => {
    let exitCode = 0
    let lastCompletedStepFromServer = 0
    let budgetExceeded = false
    let tokensTotal = 0
    let tokenBudget = null
    try {
      const data = JSON.parse(e.data)
      exitCode = data.exitCode ?? 0
      lastCompletedStepFromServer = data.lastCompletedStep ?? 0
      budgetExceeded = data.budgetExceeded === true
      tokensTotal = Number(data.tokensTotal) || 0
      tokenBudget = data.tokenBudget == null ? null : Number(data.tokenBudget)
    } catch {}
    es.close()

    // Tear down the stop button — stream is closed; nothing to stop.
    if (stopBtn) {
      stopBtn.removeEventListener('click', onStopClick)
      stopBtn.style.display = 'none'
    }

    // Extract issue ID from URL or number
    const issueMatch = issue.match(/\/issues\/(\d+)/) || issue.match(/^(\d+)$/)
    const issueId = issueMatch ? issueMatch[1] : issue

    // Helper: navigate via the hash router explicitly. Plain <a href="#/..."> can
    // fail to trigger hashchange when the current path already starts with "#/".
    const goTo = (path) => {
      const clean = path.startsWith('/') ? path : `/${path}`
      // Use location.assign so the browser pushes a history entry and fires
      // hashchange reliably across Safari/Chromium.
      location.assign(`${location.pathname}${location.search}#${clean}`)
      // Fallback: also dispatch the event in case the assign above doesn't
      // trigger it (same-path case).
      requestAnimationFrame(() => window.dispatchEvent(new HashChangeEvent('hashchange')))
    }

    if (exitCode === 0) {
      updateStepper(9, 'done')
      stepInfo.textContent = ''
      appendLine(out, '\n─── Resolve completed ───', 'ok')

      // Coverage: how many of the 8 steps actually ran (emitted an END marker)?
      const coverage = stepsEnded.size
      const missing = []
      for (let i = 1; i <= 8; i++) if (!stepsEnded.has(i)) missing.push(i)
      const coverageBanner = coverage < 8
        ? `<div class="sr-coverage-warn" style="background:#78350f20;border:1px solid #b45309;color:#fbbf24;padding:8px 10px;border-radius:4px;margin-bottom:8px;font-size:12px;">
             ⚠ Only <strong>${coverage}/8</strong> steps emitted an END marker. Missing: Step ${missing.join(', Step ')}.
             The transcript may be incomplete — scroll up to check.
           </div>`
        : `<div class="sr-coverage-ok" style="color:#34d399;font-size:11px;margin-bottom:6px;">✓ All 8 steps ran (START/END markers found)</div>`

      // Fetch PR info and show result card
      let prHtml = ''
      try {
        const prRes = await fetch(`/api/skill/resolve/pr?issueId=${encodeURIComponent(issueId)}`)
        const pr = await prRes.json()
        if (pr && pr.number) {
          const badge = pr.draft ? 'DRAFT' : pr.state
          prHtml = `<a href="${pr.url}" target="_blank" style="color:#60a5fa;text-decoration:none;font-size:12px;">PR #${pr.number} (${badge})</a>`
        }
      } catch {}

      resultEl.innerHTML = `
        ${coverageBanner}
        <div class="sr-result-card success">
          <div class="sr-result-icon">${coverage < 8 ? '⚠' : '✅'}</div>
          <div class="sr-result-body">
            <div class="sr-result-title" style="color:${coverage < 8 ? '#fbbf24' : '#34d399'};">
              Issue #${issueId} ${coverage < 8 ? 'partially resolved' : 'resolved'}
            </div>
            <div class="sr-result-meta">
              <span>${coverage}/8 steps completed</span>
              ${prHtml ? `<span>•</span>${prHtml}` : ''}
            </div>
          </div>
          <div class="sr-result-actions">
            <button class="sr-result-btn" data-transcript="${issueId}" title="View per-step transcript and token usage">📊 Transcript</button>
            <button class="sr-result-btn sr-result-btn-primary" data-goto="/dashboard/instance/${issueId}">View Detail</button>
            ${prHtml ? `<a class="sr-result-btn" href="${resultEl.querySelector?.('a')?.href || '#'}" target="_blank">Open PR</a>` : ''}
          </div>
        </div>
      `
      // Fix: get PR URL from the fetched data for the "Open PR" button
      try {
        const prLink = resultEl.querySelector('.sr-result-meta a')
        const openPrBtn = resultEl.querySelector('.sr-result-actions a.sr-result-btn')
        if (prLink && openPrBtn) openPrBtn.href = prLink.href
      } catch {}

    } else if (wasManuallyCancelled) {
      // User clicked the Stop button.  Distinct from generic failure
      // (no underlying bug) and from budget-exceeded (user chose vs.
      // limit hit).  Failure-pattern matching is suppressed — there's
      // no "fix" for "you stopped this".  Resume from last completed
      // step is offered when the run got past Step 1.
      updateStepper(currentStep, 'failed')
      stepInfo.textContent = ''
      appendLine(out, `\n─── Stopped manually (last completed: Step ${lastCompletedStepFromServer}/8) ───`, 'log')

      const lastCompleted = Math.max(
        lastCompletedStepFromServer || 0,
        stepsEnded.size > 0 ? Math.max(...stepsEnded) : 0,
      )
      const nextStep = Math.min(lastCompleted + 1, 8)
      const canResume = lastCompleted > 0 && nextStep <= 8

      resultEl.innerHTML = `
        <div class="sr-result-card failure" style="border-color:#374151;background:#11182750;">
          <div class="sr-result-icon">🛑</div>
          <div class="sr-result-body">
            <div class="sr-result-title" style="color:#9ca3af;">Stopped manually</div>
            <div class="sr-result-meta">
              <span>Issue #${issueId}</span>
              ${lastCompleted > 0 ? `<span>•</span><span style="color:#9ca3af;">Last completed: Step ${lastCompleted}/8</span>` : ''}
              ${tokensTotal > 0 ? `<span>•</span><span style="color:#60a5fa;">${(tokensTotal/1_000_000).toFixed(1)}M tokens</span>` : ''}
            </div>
          </div>
          <div class="sr-result-actions">
            <button class="sr-result-btn" data-transcript="${issueId}" title="View per-step transcript and token usage">📊 Transcript</button>
            ${canResume ? `<button class="sr-result-btn sr-result-btn-primary" data-resume="${issueId}" data-next-step="${nextStep}" title="Re-launch with --resume and pick up from Step ${nextStep}">↻ Resume from Step ${nextStep}</button>` : ''}
            <button class="sr-result-btn" data-goto="/dashboard/instance/${issueId}">View Detail</button>
          </div>
        </div>
      `

      // Wire the resume button identically to the generic failure-card path.
      const resumeBtn = resultEl.querySelector('[data-resume]')
      if (resumeBtn) {
        resumeBtn.addEventListener('click', (ev) => {
          ev.preventDefault()
          resumeBtn.disabled = true
          resumeBtn.textContent = 'Resuming…'
          appendLine(out, `\n─── Resuming from Step ${nextStep} ───`, 'log')
          startResumeStream(issueId, out, stepInfo, updateStepper, resultEl, () => {
            resumeBtn.disabled = false
            resumeBtn.textContent = `↻ Resume from Step ${nextStep}`
          })
        })
      }

    } else if (budgetExceeded) {
      // Run hit the configured token budget and we SIGTERM'd the agent.
      // Distinct card variant — this isn't a bug, it's a configured
      // limit being respected.  Surfaces the tokens-vs-budget number
      // so the user can decide whether to bump the cap and retry, or
      // investigate why the run blew through.
      updateStepper(currentStep, 'failed')
      stepInfo.textContent = ''
      appendLine(out, `\n─── Stopped at token budget (${tokensTotal.toLocaleString()} / ${(tokenBudget || 0).toLocaleString()}) ───`, 'err')
      const fmtTok = (n) => n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : (n / 1_000).toFixed(0) + 'K'
      const overage = tokenBudget ? Math.round(100 * (tokensTotal - tokenBudget) / tokenBudget) : 0

      resultEl.innerHTML = `
        <div class="sr-result-card failure" style="border-color:#b45309;background:#78350f15;">
          <div class="sr-result-icon">🪙</div>
          <div class="sr-result-body">
            <div class="sr-result-title" style="color:#fbbf24;">Stopped at token budget</div>
            <div class="sr-result-meta">
              <span>Issue #${issueId}</span>
              <span>•</span>
              <span style="color:#fbbf24;">${fmtTok(tokensTotal)} used</span>
              <span>/</span>
              <span style="color:#9ca3af;">${fmtTok(tokenBudget || 0)} cap</span>
              ${overage > 0 ? `<span style="color:#f87171;">(+${overage}%)</span>` : ''}
              <span>•</span>
              <span style="color:#9ca3af;">Last completed: Step ${currentStep}</span>
            </div>
          </div>
          <div class="sr-result-actions">
            <button class="sr-result-btn" data-transcript="${issueId}" title="View per-step transcript and token usage">📊 Transcript</button>
            <button class="sr-result-btn" data-goto="/dashboard/instance/${issueId}">View Detail</button>
          </div>
        </div>
        <div style="margin-top:8px;font-size:11px;color:#9ca3af;line-height:1.5;">
          <strong style="color:#fbbf24;">What happened:</strong>
          The resolve agent crossed the configured per-run token cap.  It was sent SIGTERM and stopped at the line above.<br>
          <strong style="color:#9ca3af;">Next steps:</strong>
          edit <code>~/.swctl/config.json</code> → <code>features.resolveTokenBudget</code> to raise the limit, or open the 📊 transcript above to see which step burned through the budget (often a runaway tool-use loop).
        </div>
      `

    } else if (inCreatePhase) {
      // Failure happened DURING the create phase — the resolve agent
      // never started.  Show a create-failure card with a "Retry"
      // button that cleans the half-built worktree and re-runs the
      // whole resolve from scratch.  Resume isn't applicable here:
      // partial creates leave fragmented state (broken DB clone,
      // half-checked-out worktree, unstarted container) that's
      // simpler to wipe than to surgically continue.
      updCreate(lastCreateStep || 1, 'failed')
      stepInfo.textContent = ''
      appendLine(out, `\n─── Create failed (exit ${exitCode}) ───`, 'err')
      const stepLabel = lastCreateStep
        ? `Step ${lastCreateStep}/5: ${lastCreateStepName}`
        : 'Pre-flight or earlier'

      resultEl.innerHTML = `
        <div class="sr-result-card failure">
          <div class="sr-result-icon">❌</div>
          <div class="sr-result-body">
            <div class="sr-result-title" style="color:#f87171;">Create failed at ${escape(stepLabel)}</div>
            <div class="sr-result-meta">
              <span>Issue #${issueId} • exit code ${exitCode}</span>
            </div>
          </div>
          <div class="sr-result-actions">
            <button class="sr-result-btn sr-result-btn-primary" data-retry-create="${issueId}" title="Clean the half-built worktree and re-run the whole resolve from scratch">🔄 Clean + Retry</button>
            <button class="sr-result-btn" data-goto="/dashboard/instance/${issueId}">View Detail</button>
          </div>
        </div>
      `

      const retryBtn = resultEl.querySelector('[data-retry-create]')
      if (retryBtn) {
        retryBtn.addEventListener('click', (ev) => {
          ev.preventDefault()
          retryBtn.disabled = true
          retryBtn.textContent = 'Cleaning…'
          retryAfterCreateFailure(
            issue, project, mode,
            out, stepInfo, updateStepper, resultEl, onDone, updateCreateStepper,
            issueId,
          ).catch((err) => {
            appendLine(out, `[retry] failed: ${err && err.message || err}`, 'err')
            retryBtn.disabled = false
            retryBtn.textContent = '🔄 Clean + Retry'
          })
        })
      }
    } else {
      updateStepper(currentStep, 'failed')
      stepInfo.textContent = ''
      appendLine(out, `\n─── Failed (exit ${exitCode}) ───`, 'err')

      // Prefer the server-reported last-completed step (trusted source — it
      // ran the stream parser); fall back to the client stepper's view.
      const lastCompleted = Math.max(
        lastCompletedStepFromServer || 0,
        stepsEnded.size > 0 ? Math.max(...stepsEnded) : 0,
      )
      const nextStep = Math.min(lastCompleted + 1, 8)
      const canResume = lastCompleted > 0 && nextStep <= 8

      resultEl.innerHTML = `
        <div class="sr-result-card failure">
          <div class="sr-result-icon">❌</div>
          <div class="sr-result-body">
            <div class="sr-result-title" style="color:#f87171;">Failed at Step ${currentStep}: ${stepNames[currentStep] || ''}</div>
            <div class="sr-result-meta">
              <span>Issue #${issueId} • exit code ${exitCode}</span>
              ${canResume ? `<span>•</span><span style="color:#fbbf24;">Last completed: Step ${lastCompleted}</span>` : ''}
            </div>
          </div>
          <div class="sr-result-actions">
            <button class="sr-result-btn" data-transcript="${issueId}" title="View per-step transcript and token usage">📊 Transcript</button>
            ${canResume ? `<button class="sr-result-btn sr-result-btn-primary" data-resume="${issueId}" data-next-step="${nextStep}" title="Re-launch Claude with --resume and pick up from Step ${nextStep}">↻ Resume from Step ${nextStep}</button>` : ''}
            <button class="sr-result-btn" data-goto="/dashboard/instance/${issueId}">View Detail</button>
          </div>
        </div>
      `

      // Wire the Resume button to stream into the same console
      const resumeBtn = resultEl.querySelector('[data-resume]')
      if (resumeBtn) {
        resumeBtn.addEventListener('click', (ev) => {
          ev.preventDefault()
          resumeBtn.disabled = true
          resumeBtn.textContent = 'Resuming…'
          appendLine(out, `\n─── Resuming from Step ${nextStep} ───`, 'log')
          // Launch a fresh EventSource against the resume endpoint.  The old
          // `es` is already closed; its reference in the parent scope is no
          // longer relevant for this run.
          startResumeStream(issueId, out, stepInfo, updateStepper, resultEl, () => {
            resumeBtn.disabled = false
            resumeBtn.textContent = `↻ Resume from Step ${nextStep}`
          })
        })
      }
    }

    // Wire any buttons with data-goto="/path" to use the router-aware nav helper
    resultEl.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault()
        goTo(btn.getAttribute('data-goto'))
      })
    })

    // Wire transcript buttons (success + failure cards both render one).
    resultEl.querySelectorAll('[data-transcript]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault()
        openTranscriptModal(btn.getAttribute('data-transcript'))
      })
    })

    // Scroll result card into view
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' })

    // OS notification when the user is on another tab.  Picks the
    // right title + body for the three terminal states; silently
    // no-ops when the user is focused on this tab or has denied
    // permission.  See notifyResolveDone() for the full policy.
    const notifyStatus = budgetExceeded
      ? 'budget-exceeded'
      : (exitCode === 0 ? 'done' : 'failed')
    notifyResolveDone({
      issueId,
      status: notifyStatus,
      durationMs: Date.now() - streamStartedAt,
      stepsCompleted: stepsEnded.size,
      tokensTotal,
    })

    try {
      await fetch('/api/skill/resolve/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue, exitCode }),
      })
    } catch {}
    if (onDone) onDone(exitCode)
  })

  es.addEventListener('error', (e) => {
    let msg = 'Stream error'
    try { msg = JSON.parse(e.data).message || msg } catch {}
    updateStepper(currentStep, 'failed')
    stepInfo.textContent = `Error at Step ${currentStep}`
    stepInfo.style.color = '#f87171'
    appendLine(out, `ERROR: ${msg}`, 'err')
    es.close()
    if (onDone) onDone(1)
  })

  return es
}

/**
 * Open an SSE stream against /api/skill/resolve/resume/stream and pipe it
 * into the same console + stepper used by the initial run.  Invokes
 * onDone with the final exitCode.  Does not re-render the failure card
 * itself — caller is responsible for swapping the card on completion.
 */
function startResumeStream(issueId, out, stepInfo, updateStepper, resultEl, onDone) {
  const url = `/api/skill/resolve/resume/stream?issueId=${encodeURIComponent(issueId)}`
  const es = new EventSource(url)
  let currentStep = 0
  const stepNames = {
    1: 'Verify the issue',
    2: 'Find root cause',
    3: 'Implement the fix',
    4: 'Independent review',
    5: 'Provision environment',
    6: 'Test and validate',
    7: 'Prepare for merge',
    8: 'Decision-ready output',
  }
  const stepsEnded = new Set()

  es.addEventListener('log', (e) => {
    try {
      const data = JSON.parse(e.data)
      const line = data.line || ''
      renderLine(out, line)
      const startMatch = line.match(/###\s*STEP\s+(\d)\s+START/i)
      const endMatch = line.match(/###\s*STEP\s+(\d)\s+END/i)
      if (startMatch) {
        const n = parseInt(startMatch[1])
        if (n >= 1 && n <= 8) {
          currentStep = n
          updateStepper(n, 'active')
          stepInfo.textContent = `Step ${n}: ${stepNames[n] || ''}`
        }
      } else if (endMatch) {
        const n = parseInt(endMatch[1])
        if (n >= 1 && n <= 8) {
          stepsEnded.add(n)
          updateStepper(n, 'done')
        }
      }
    } catch {}
  })

  es.addEventListener('done', async (e) => {
    let exitCode = 0
    let last = 0
    try {
      const d = JSON.parse(e.data)
      exitCode = d.exitCode ?? 0
      last = d.lastCompletedStep ?? 0
    } catch {}
    es.close()

    appendLine(out, `\n─── Resume done (exit ${exitCode}) ───`, exitCode === 0 ? 'ok' : 'err')

    if (exitCode === 0) {
      updateStepper(9, 'done')
      stepInfo.textContent = ''
      resultEl.innerHTML = `
        <div class="sr-result-card success">
          <div class="sr-result-icon">✅</div>
          <div class="sr-result-body">
            <div class="sr-result-title" style="color:#34d399;">Issue #${issueId} resolved (via resume)</div>
            <div class="sr-result-meta"><span>Finished at Step ${Math.max(last, ...stepsEnded, 0)}</span></div>
          </div>
          <div class="sr-result-actions">
            <button class="sr-result-btn sr-result-btn-primary" data-goto="/dashboard/instance/${issueId}">View Detail</button>
          </div>
        </div>
      `
      resultEl.querySelectorAll('[data-goto]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.preventDefault()
          const target = btn.getAttribute('data-goto')
          const clean = target.startsWith('/') ? target : `/${target}`
          location.assign(`${location.pathname}${location.search}#${clean}`)
          requestAnimationFrame(() => window.dispatchEvent(new HashChangeEvent('hashchange')))
        })
      })
    } else {
      // Still failed — update the card to reflect the new step and enable
      // another resume attempt from there.
      const lastCompleted = Math.max(last, stepsEnded.size > 0 ? Math.max(...stepsEnded) : 0)
      const nextStep = Math.min(lastCompleted + 1, 8)
      resultEl.innerHTML = `
        <div class="sr-result-card failure">
          <div class="sr-result-icon">❌</div>
          <div class="sr-result-body">
            <div class="sr-result-title" style="color:#f87171;">Still failing at Step ${currentStep}: ${stepNames[currentStep] || ''}</div>
            <div class="sr-result-meta">
              <span>Issue #${issueId} • exit ${exitCode}</span>
              <span>•</span>
              <span style="color:#fbbf24;">Last completed: Step ${lastCompleted}</span>
            </div>
          </div>
          <div class="sr-result-actions">
            <button class="sr-result-btn sr-result-btn-primary" data-resume-again="${issueId}" data-next-step="${nextStep}">↻ Retry from Step ${nextStep}</button>
            <button class="sr-result-btn" data-goto="/dashboard/instance/${issueId}">View Detail</button>
          </div>
        </div>
      `
      const retryBtn = resultEl.querySelector('[data-resume-again]')
      if (retryBtn) {
        retryBtn.addEventListener('click', (ev) => {
          ev.preventDefault()
          retryBtn.disabled = true
          retryBtn.textContent = 'Resuming…'
          appendLine(out, `\n─── Retrying from Step ${nextStep} ───`, 'log')
          startResumeStream(issueId, out, stepInfo, updateStepper, resultEl, () => {
            retryBtn.disabled = false
          })
        })
      }
      resultEl.querySelectorAll('[data-goto]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.preventDefault()
          const target = btn.getAttribute('data-goto')
          const clean = target.startsWith('/') ? target : `/${target}`
          location.assign(`${location.pathname}${location.search}#${clean}`)
          requestAnimationFrame(() => window.dispatchEvent(new HashChangeEvent('hashchange')))
        })
      })
    }

    // Tell the server to update resolve-runs.json
    try {
      await fetch('/api/skill/resolve/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue: issueId, exitCode }),
      })
    } catch {}

    if (onDone) onDone(exitCode)
  })

  es.addEventListener('error', (e) => {
    let msg = 'Stream error'
    try { msg = JSON.parse(e.data).message || msg } catch {}
    appendLine(out, `ERROR: ${msg}`, 'err')
    es.close()
    if (onDone) onDone(1)
  })

  return es
}

function appendLine(pre, text, kind) {
  // Simple, used for banners ("Resolve completed", "Failed", "Error") only.
  // For live stream output, use renderLine which parses stream-json.
  const span = document.createElement('div')
  span.className = 'sr-log-row ' + (kind === 'ok' ? 'sr-log-banner-ok' : kind === 'err' ? 'sr-log-banner-err' : 'sr-log-banner')
  span.textContent = text
  pre.appendChild(span)
  pre.scrollTop = pre.scrollHeight
}

/**
 * Render one SSE log line into the console.  Claude Code's
 * `--output-format stream-json` emits one JSON object per line; swctl's own
 * messages ([swctl]/[scope]/### STEP markers) arrive as plain text.
 */
function renderLine(pre, raw) {
  const row = (cls, text, attrs) => {
    const el = document.createElement('div')
    el.className = 'sr-log-row ' + cls
    if (attrs) Object.entries(attrs).forEach(([k, v]) => { el[k] = v })
    if (typeof text === 'string') el.textContent = text
    else if (text) el.appendChild(text)
    pre.appendChild(el)
    pre.scrollTop = pre.scrollHeight
    return el
  }

  // Non-JSON plain lines — swctl log, step markers, blank lines
  const trimmed = String(raw || '').trim()
  if (!trimmed) return

  if (!trimmed.startsWith('{')) {
    if (/^###\s*STEP\s+\d+\s+END\b/i.test(trimmed)) return row('sr-log-step-end', trimmed)
    if (/^###\s*STEP\s+\d+\s+START\b/i.test(trimmed)) return row('sr-log-step', trimmed)
    if (/^\[(swctl|scope|branch|claude)\]/i.test(trimmed)) return row('sr-log-swctl', trimmed)
    return row('sr-log-text', trimmed)
  }

  let event
  try { event = JSON.parse(raw) } catch { return row('sr-log-text', trimmed) }

  const type = event.type

  if (type === 'system') {
    const model = event.model || event.config?.model || ''
    const tools = Array.isArray(event.tools) ? ` tools=${event.tools.length}` : ''
    return row('sr-log-banner', `● session started${model ? ` model=${model}` : ''}${tools}`)
  }

  if (type === 'result') {
    const code = event.subtype === 'success' ? 0 : (event.is_error ? 1 : (event.exitCode ?? 0))
    const ms = event.duration_ms ? ` in ${Math.round(event.duration_ms / 1000)}s` : ''
    return row(code === 0 ? 'sr-log-banner-ok' : 'sr-log-banner-err', `● done exit ${code}${ms}`)
  }

  if (type === 'assistant' || type === 'user') {
    const content = event.message?.content
    const blocks = Array.isArray(content) ? content : []
    for (const b of blocks) renderBlock(pre, row, b, type)
    return
  }

  // ---- Codex `--json` JSONL events ----
  // Codex wraps everything in turn / item envelopes.  We render only on
  // item.completed (item.started would double-render) and decode the
  // item-type payload into the same row vocabulary Claude already uses
  // (text / tool_use / tool_result / banner) so the two backends look
  // visually consistent.
  if (type === 'thread.started') {
    return row('sr-log-banner', `● codex session ${(event.thread_id || '').slice(0, 8) || 'started'}`)
  }
  if (type === 'turn.started' || type === 'item.started') {
    // Suppress — turn.started carries no info; item.started is followed
    // by item.completed which has the actual content.
    return
  }
  if (type === 'turn.completed') {
    const u = event.usage || {}
    const tok = (u.input_tokens || 0) + (u.output_tokens || 0)
    if (!tok) return
    return row('sr-log-banner', `● turn complete (${tok.toLocaleString()} tokens)`)
  }
  if (type === 'thread.completed') {
    return row('sr-log-banner-ok', `● codex session done`)
  }
  if (type === 'item.completed' && event.item && typeof event.item === 'object') {
    return renderCodexItem(pre, row, event.item)
  }

  // Unknown event types: show a compact one-liner
  row('sr-log-banner', `● ${type || 'event'}`)
}

/**
 * Render one completed Codex item as the same kind of row Claude's
 * stream-json blocks render to.  Item shape (Codex 0.x):
 *   - { type: "agent_message", text: "..." }
 *   - { type: "command_execution", command, aggregated_output, exit_code, status }
 *   - { type: "file_change", changes: [{ path, kind: "add"|"update"|"delete" }], status }
 */
function renderCodexItem(pre, row, item) {
  if (item.type === 'agent_message' && typeof item.text === 'string') {
    // Reuse the same line-by-line + STEP marker logic as Claude's text blocks
    const lines = item.text.split('\n')
    for (const line of lines) {
      if (!line.trim()) { row('sr-log-text', ' '); continue }
      if (/^###\s*STEP\s+\d+\s+END\b/i.test(line)) { row('sr-log-step-end', line); continue }
      if (/^###\s*STEP\s+\d+\s+START\b/i.test(line)) { row('sr-log-step', line); continue }
      row('sr-log-text', line)
    }
    return
  }

  if (item.type === 'command_execution') {
    const cmd = String(item.command || '').replace(/\s+/g, ' ').slice(0, 240)
    row('sr-log-tool-bash', `▸ Bash: ${cmd}`)
    const out = String(item.aggregated_output || '').replace(/\r\n/g, '\n')
    if (out.trim()) {
      const firstLine = (out.split('\n').find(l => l.trim()) || '').slice(0, 200)
      const totalLines = out.split('\n').length
      const code = item.exit_code
      const err = (typeof code === 'number' && code !== 0) ? ` (exit ${code})` : ''
      const container = document.createElement('div')
      container.className = 'sr-log-row sr-log-result'
      const head = document.createElement('div')
      head.innerHTML = `<span class="sr-log-caret"></span>⤷ <span>${escape(firstLine)}</span><span style="color:#475569;margin-left:6px;">…(${totalLines} line${totalLines === 1 ? '' : 's'})${err}</span>`
      const body = document.createElement('div')
      body.className = 'sr-log-result-body'
      body.textContent = out
      body.style.display = 'none'
      head.style.cursor = 'pointer'
      head.addEventListener('click', () => {
        body.style.display = body.style.display === 'none' ? 'block' : 'none'
      })
      container.appendChild(head)
      container.appendChild(body)
      pre.appendChild(container)
      pre.scrollTop = pre.scrollHeight
    }
    return
  }

  if (item.type === 'file_change' && Array.isArray(item.changes)) {
    for (const ch of item.changes) {
      const verb = ch.kind === 'add' ? '✎ Add' : ch.kind === 'delete' ? '✎ Delete' : '✎ Edit'
      row('sr-log-tool-edit', `${verb}: ${ch.path || ''}`)
    }
    return
  }

  // Unknown item type — fall back to a compact banner
  row('sr-log-banner', `● ${item.type || 'item'}`)
}

function renderBlock(pre, row, block, eventType) {
  if (!block || typeof block !== 'object') return

  if (block.type === 'text' && typeof block.text === 'string') {
    const lines = block.text.split('\n')
    for (const line of lines) {
      if (!line.trim()) { row('sr-log-text', '\u00A0'); continue }
      if (/^###\s*STEP\s+\d+\s+END\b/i.test(line)) { row('sr-log-step-end', line); continue }
      if (/^###\s*STEP\s+\d+\s+START\b/i.test(line)) { row('sr-log-step', line); continue }
      row('sr-log-text', line)
    }
    return
  }

  if (block.type === 'thinking' && typeof block.thinking === 'string') {
    const snippet = block.thinking.replace(/\s+/g, ' ').slice(0, 240)
    row('sr-log-think', `💭 ${snippet}${block.thinking.length > 240 ? '…' : ''}`)
    return
  }

  if (block.type === 'tool_use') {
    const name = block.name || 'tool'
    const input = block.input || {}
    let kind = 'sr-log-tool-other'
    let label = name
    let detail = ''
    if (name === 'Bash') {
      kind = 'sr-log-tool-bash'
      label = '▸ Bash'
      detail = (input.command || '').replace(/\s+/g, ' ').slice(0, 240)
    } else if (name === 'Edit' || name === 'Write') {
      kind = 'sr-log-tool-edit'
      label = name === 'Edit' ? '✎ Edit' : '✎ Write'
      detail = input.file_path || ''
    } else if (name === 'Read') {
      kind = 'sr-log-tool-edit'
      label = '📄 Read'
      detail = input.file_path || ''
    } else if (name === 'Grep' || name === 'Glob') {
      kind = 'sr-log-tool-other'
      label = `🔎 ${name}`
      detail = input.pattern || input.path || ''
    } else if (name === 'Task') {
      kind = 'sr-log-tool-task'
      label = '↻ Task'
      detail = input.subagent_type || input.description || ''
    } else if (name === 'WebFetch' || name === 'WebSearch') {
      kind = 'sr-log-tool-web'
      label = name === 'WebFetch' ? '🌐 WebFetch' : '🔍 WebSearch'
      detail = input.url || input.query || ''
    } else {
      detail = Object.entries(input).slice(0, 1).map(([k, v]) =>
        `${k}=${String(v).replace(/\s+/g, ' ').slice(0, 120)}`).join('')
    }
    row(kind, `${label}: ${detail}`)
    return
  }

  if (block.type === 'tool_result') {
    let text = ''
    if (typeof block.content === 'string') text = block.content
    else if (Array.isArray(block.content)) {
      text = block.content.map(c => (c && typeof c === 'object' && typeof c.text === 'string') ? c.text : '').join('')
    }
    text = text.replace(/\r\n/g, '\n')
    const firstLine = (text.split('\n').find(l => l.trim()) || '').slice(0, 200)
    const totalLines = text.split('\n').length
    const err = block.is_error ? ' (error)' : ''

    const container = document.createElement('div')
    container.className = 'sr-log-row sr-log-result'
    const head = document.createElement('div')
    head.innerHTML = `<span class="sr-log-caret"></span>⤷ <span>${escape(firstLine)}</span><span style="color:#475569;margin-left:6px;">…(${totalLines} line${totalLines === 1 ? '' : 's'})${err}</span>`
    const body = document.createElement('div')
    body.className = 'sr-log-result-body'
    body.textContent = text
    container.appendChild(head)
    container.appendChild(body)
    container.addEventListener('click', () => container.classList.toggle('open'))
    pre.appendChild(container)
    pre.scrollTop = pre.scrollHeight
  }
}

// ---------- Route: /resolve (issues table + create form + console) ----------

function renderResolvePage(el, ctx) {
  const activeProject = ctx.activeProject.value || ''

  el.innerHTML = `
    <style>
      .sr-wrap { font-family: ui-sans-serif, system-ui, sans-serif; color: #e5e7eb; max-width: 1200px; }
      .sr-header { font-size: 20px; font-weight: 600; margin: 0 0 4px 0; }
      .sr-sub    { color: #9ca3af; font-size: 13px; margin: 0 0 16px 0; }

      /* Create form */
      .sr-create { margin-bottom: 20px; padding: 12px; background: #111827; border: 1px solid #1f2937; border-radius: 6px; }
      .sr-create-row { display: flex; gap: 8px; align-items: center; }
      .sr-create input {
        background: #0f172a; border: 1px solid #374151; border-radius: 4px;
        padding: 8px 10px; font: 13px ui-sans-serif, system-ui, sans-serif; color: #e5e7eb; flex: 1;
      }
      .sr-create input:focus { outline: none; border-color: #3b82f6; }
      .sr-create button {
        background: #2563eb; border: none; border-radius: 4px; color: #fff; cursor: pointer;
        padding: 8px 16px; font: 13px ui-sans-serif, system-ui, sans-serif; font-weight: 600;
        white-space: nowrap;
      }
      .sr-create button:hover { background: #1d4ed8; }
      .sr-create button:disabled { opacity: .4; cursor: not-allowed; }
      .sr-fetch-btn {
        background: #374151; border: none; border-radius: 4px; color: #d1d5db; cursor: pointer;
        padding: 8px 12px; font: 13px ui-sans-serif, system-ui, sans-serif; white-space: nowrap;
      }
      .sr-fetch-btn:hover { background: #4b5563; }
      .sr-fetch-btn:disabled { opacity: .4; cursor: not-allowed; }
      .sr-issue-picker { margin-top: 10px; max-height: 300px; overflow-y: auto; border: 1px solid #1f2937; border-radius: 4px; }
      .sr-issue-row {
        display: flex; align-items: center; gap: 8px; padding: 6px 10px;
        border-bottom: 1px solid #1f2937; font-size: 12px; cursor: pointer; transition: background 0.1s;
      }
      .sr-issue-row:hover { background: #1e293b; }
      .sr-issue-row.selected { background: #1e3a5f; }
      .sr-issue-row input[type=checkbox] { accent-color: #3b82f6; cursor: pointer; }
      .sr-issue-num { color: #60a5fa; font-weight: 600; min-width: 50px; }
      .sr-issue-title { color: #d1d5db; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sr-issue-labels { display: flex; gap: 3px; }
      .sr-issue-label { font-size: 9px; padding: 1px 5px; border-radius: 8px; background: #1f2937; color: #9ca3af; }
      .sr-selected-count { font-size: 12px; color: #9ca3af; margin-top: 8px; }

      /* Label-button filter (populated from /api/github/labels/defaults) —
         per-label colour families on the active state, matching how issue
         labels render in the result list. */
      /* GitHub-style smart filter bar: contenteditable with live token
         highlighting + autocomplete dropdown. */
      .sr-smart-wrap { position: relative; margin: 8px 0; }
      .sr-smart-input {
        min-height: 28px;
        padding: 6px 10px;
        border: 1px solid #374151; border-radius: 6px;
        background: #0f172a; color: #d1d5db;
        font: 12px/1.6 ui-monospace, SFMono-Regular, monospace;
        outline: none;
        white-space: pre-wrap; word-break: break-word;
      }
      .sr-smart-input:focus { border-color: #3b82f6; box-shadow: 0 0 0 1px #1e3a5f; }
      .sr-smart-input:empty::before {
        content: attr(data-placeholder);
        color: #4b5563;
        pointer-events: none;
      }
      .sr-tok {
        display: inline-block;
        padding: 0 4px; margin: 0 1px;
        border-radius: 3px;
        background: #1f2937;
      }
      .sr-tok-key { color: #93c5fd; font-weight: 600; }
      .sr-tok-val { color: #d1d5db; }
      .sr-tok.tk-label { background: #3730a3; }
      .sr-tok.tk-label .sr-tok-key { color: #c7d2fe; }
      .sr-tok.tk-label .sr-tok-val { color: #e0e7ff; }
      .sr-tok.tk-is    { background: #1e40af; }
      .sr-tok.tk-is    .sr-tok-key { color: #bfdbfe; }
      .sr-tok.tk-is    .sr-tok-val { color: #dbeafe; }
      .sr-tok.tk-state { background: #065f46; }
      .sr-tok.tk-state .sr-tok-key { color: #a7f3d0; }
      .sr-tok.tk-state .sr-tok-val { color: #d1fae5; }
      .sr-tok.tk-sort  { background: #334155; }
      .sr-tok.tk-sort  .sr-tok-key { color: #cbd5e1; }
      .sr-tok.tk-sort  .sr-tok-val { color: #e2e8f0; }
      .sr-tok.tk-assignee { background: #86198f; }
      .sr-tok.tk-assignee .sr-tok-key { color: #f5d0fe; }
      .sr-tok.tk-assignee .sr-tok-val { color: #fae8ff; }

      .sr-smart-ac {
        position: absolute; top: calc(100% + 2px); left: 0; z-index: 100;
        background: #0f172a; border: 1px solid #374151; border-radius: 6px;
        min-width: 260px; max-height: 280px; overflow-y: auto;
        padding: 4px 0;
        box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        font: 12px ui-sans-serif, sans-serif;
      }
      .sr-smart-ac-item {
        padding: 6px 10px; color: #d1d5db; cursor: pointer;
        display: flex; align-items: baseline; gap: 6px;
      }
      .sr-smart-ac-item.active,
      .sr-smart-ac-item:hover { background: #1e293b; }
      .sr-smart-ac-item-display { color: #d1d5db; font: 11px ui-monospace, monospace; }
      .sr-smart-ac-item-display .k { color: #93c5fd; font-weight: 600; }
      .sr-smart-ac-item-display .v { color: #e5e7eb; }
      .sr-smart-ac-item-hint { color: #6b7280; font-size: 10px; margin-left: auto; }

      /* Issues table */
      .sr-table { width: 100%; border-collapse: collapse; font: 12px ui-monospace, monospace; margin-bottom: 20px; }
      .sr-table th { text-align: left; color: #6b7280; font-weight: 600; padding: 8px 6px; border-bottom: 2px solid #1f2937; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
      .sr-table td { padding: 8px 6px; border-bottom: 1px solid #1f2937; vertical-align: middle; }
      .sr-table tr:hover td { background: #111827; }
      .sr-pr-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; }
      .sr-pr-open { background: #064e3b; color: #34d399; }
      .sr-pr-draft { background: #1e293b; color: #94a3b8; }
      .sr-pr-merged { background: #312e81; color: #a78bfa; }
      .sr-pr-closed { background: #450a0a; color: #f87171; }
      .sr-pr-none { background: #1f2937; color: #6b7280; }
      .sr-btn {
        background: #1f2937; border: 1px solid #374151; border-radius: 4px;
        color: #9ca3af; font: 11px ui-sans-serif, sans-serif; padding: 3px 8px;
        cursor: pointer; transition: all 0.15s;
      }
      .sr-btn:hover { background: #374151; color: #e5e7eb; }
      .sr-btn-primary { background: #1e40af; border-color: #2563eb; color: #93c5fd; }
      .sr-btn-primary:hover { background: #2563eb; color: #fff; }
      .sr-btn-danger { background: #7f1d1d; border-color: #991b1b; color: #fca5a5; }
      .sr-btn-danger:hover { background: #991b1b; color: #fff; }

      /* Console */
      .sr-console {
        background: #0f172a; border: 1px solid #1f2937; border-radius: 6px;
        padding: 12px; font: 12px/1.6 ui-monospace, SFMono-Regular, monospace;
        color: #cbd5e1; min-height: 200px; max-height: 50vh; overflow-y: auto;
        white-space: pre-wrap; word-break: break-word;
      }
      .sr-console:empty::before { content: 'Claude output will appear here...'; color: #4b5563; }

      /* Rendered log blocks — structured view of Claude's stream-json */
      .sr-log-row        { padding: 2px 8px; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere;
                           line-height: 1.55; border-left: 3px solid transparent; font: 12px ui-monospace, SFMono-Regular, monospace; }
      .sr-log-row + .sr-log-row { margin-top: 1px; }
      .sr-log-text       { color: #cbd5e1; }
      .sr-log-step       { color: #34d399; font-weight: 600; border-left-color: #065f46; background: #064e3b18; }
      .sr-log-step-end   { color: #6ee7b7; border-left-color: #047857; }
      .sr-log-swctl      { color: #fbbf24; border-left-color: #b45309; }
      .sr-log-banner     { color: #94a3b8; font-style: italic; opacity: .8; }
      .sr-log-banner-ok  { color: #34d399; }
      .sr-log-banner-err { color: #f87171; }
      .sr-log-tool-bash  { color: #86efac; border-left-color: #22c55e; }
      .sr-log-tool-edit  { color: #93c5fd; border-left-color: #3b82f6; }
      .sr-log-tool-task  { color: #d8b4fe; border-left-color: #a855f7; }
      .sr-log-tool-web   { color: #67e8f9; border-left-color: #06b6d4; }
      .sr-log-tool-other { color: #cbd5e1; border-left-color: #475569; }
      .sr-log-result     { color: #9ca3af; border-left-color: #374151; cursor: pointer; }
      .sr-log-result .sr-log-caret  { display: inline-block; width: 1em; }
      .sr-log-result.open .sr-log-caret::before { content: '▾'; }
      .sr-log-result      .sr-log-caret::before { content: '▸'; }
      .sr-log-result-body { display: none; color: #94a3b8; padding: 4px 0 4px 1.5em;
                            white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow-y: auto; }
      .sr-log-result.open .sr-log-result-body { display: block; }
      .sr-log-think      { color: #64748b; font-style: italic; }
      .sr-log-prefix     { color: #475569; margin-right: 4px; }

      .sr-section { margin-bottom: 24px; }
      .sr-section-title { font-size: 14px; font-weight: 600; color: #d1d5db; margin: 0 0 10px 0; display: flex; align-items: center; gap: 8px; }
      .sr-loading { display: inline-block; color: #6b7280; font-size: 11px; }

      /* Stepper */
      .sr-stepper { display: flex; gap: 0; margin-bottom: 16px; background: #111827; border: 1px solid #1f2937; border-radius: 6px; overflow: hidden; }
      .sr-step {
        flex: 1; padding: 10px 6px; text-align: center; font-size: 11px;
        border-right: 1px solid #1f2937; transition: all 0.3s; position: relative;
        color: #6b7280; background: #111827;
      }
      .sr-step:last-child { border-right: none; }
      .sr-step-num { font-weight: 700; font-size: 13px; display: block; margin-bottom: 2px; }
      .sr-step-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.3px; }
      .sr-step.done { background: #064e3b; color: #34d399; }
      .sr-step.done .sr-step-num::before { content: '✓ '; }
      .sr-step.active { background: #1e3a5f; color: #60a5fa; }
      .sr-step.active .sr-step-num::after { content: ''; display: inline-block; width: 6px; height: 6px; background: #60a5fa; border-radius: 50%; margin-left: 4px; animation: pulse 1.5s infinite; }
      .sr-step.failed { background: #450a0a; color: #f87171; }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

      /* Create-phase stepper — sibling to .sr-stepper but visually
         compact + neutral colours so it doesn't compete with the main
         8-step resolve workflow stepper.  Displayed during the create
         phase (before the agent spawns); fades to a subdued state once
         all 5 steps complete and the resolve workflow takes over. */
      .sr-create-stepper { display: flex; gap: 0; margin-bottom: 8px; background: #0b1220; border: 1px solid #1f2937; border-radius: 4px; overflow: hidden; transition: opacity 0.4s; }
      .sr-create-stepper.complete { opacity: 0.5; }
      .sr-create-step {
        flex: 1; padding: 5px 6px; text-align: center; font-size: 10px;
        border-right: 1px solid #1f2937; transition: all 0.3s;
        color: #6b7280; background: #0b1220;
      }
      .sr-create-step:last-child { border-right: none; }
      .sr-create-step-num { font-weight: 700; font-size: 11px; display: inline-block; margin-right: 4px; }
      .sr-create-step-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.3px; }
      .sr-create-step.done { background: #064e3b40; color: #34d399; }
      .sr-create-step.done .sr-create-step-num::before { content: '✓ '; }
      .sr-create-step.active { background: #1e3a5f60; color: #60a5fa; }
      .sr-create-step.active .sr-create-step-num::after { content: ''; display: inline-block; width: 5px; height: 5px; background: #60a5fa; border-radius: 50%; margin-left: 3px; animation: pulse 1.5s infinite; }
      .sr-create-step.failed { background: #450a0a60; color: #f87171; }

      /* Result card */
      .sr-result-card {
        border: 1px solid #1f2937; border-radius: 6px; padding: 16px; margin-bottom: 12px;
        display: flex; align-items: center; gap: 12px;
      }
      .sr-result-card.success { border-color: #065f46; background: #064e3b20; }
      .sr-result-card.failure { border-color: #7f1d1d; background: #450a0a20; }
      .sr-result-icon { font-size: 24px; flex-shrink: 0; }
      .sr-result-body { flex: 1; }
      .sr-result-title { font-size: 14px; font-weight: 600; margin: 0 0 4px 0; }
      .sr-result-meta { font-size: 12px; color: #9ca3af; display: flex; gap: 12px; align-items: center; }
      .sr-result-actions { display: flex; gap: 6px; flex-shrink: 0; }
      .sr-result-btn {
        padding: 6px 14px; border-radius: 4px; font: 12px ui-sans-serif, sans-serif;
        font-weight: 600; cursor: pointer; text-decoration: none; display: inline-block;
        border: 1px solid #374151; color: #d1d5db; background: #1f2937; transition: all 0.15s;
      }
      .sr-result-btn:hover { background: #374151; color: #fff; }
      .sr-result-btn-primary { background: #1e40af; border-color: #2563eb; color: #93c5fd; }
      .sr-result-btn-primary:hover { background: #2563eb; color: #fff; }
    </style>
    <div class="sr-wrap">
      <h2 class="sr-header">Resolve</h2>
      <p class="sr-sub">Resolve Shopware issues with Claude Code — create worktrees, review diffs, and manage PRs.</p>

      <!-- Create -->
      <div class="sr-section">
        <div class="sr-create">
          <div class="sr-create-row">
            <input id="sr-repo" type="text" placeholder="Repository (e.g. shopware/shopware)" value="shopware/shopware" style="width:220px;flex:none;" />
            <button id="sr-fetch" class="sr-fetch-btn">Fetch issues</button>
            <button id="sr-run" disabled>Resolve selected</button>
            <!--
              Backend selector — Claude (default) vs Codex.  The
              chosen value is forwarded as a backend= query param on
              the SSE stream URL; the server reads it and dispatches
              to the right CLI in buildSpawnArgs.  Persisted to
              localStorage so the choice sticks across reloads.
            -->
            <label class="sr-backend-label" style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#9ca3af;margin-left:auto;">
              AI
              <select id="sr-backend" style="background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:4px;padding:2px 6px;font-size:12px;">
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label class="sr-concurrency-label" style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#9ca3af;">
              Concurrency
              <select id="sr-concurrency" style="background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:4px;padding:2px 6px;font-size:12px;">
                <option value="1">1</option>
                <option value="2" selected>2</option>
                <option value="4">4</option>
                <option value="auto">auto</option>
              </select>
            </label>
          </div>
          <div class="sr-smart-wrap">
            <div id="sr-smart-input" class="sr-smart-input" contenteditable="true" spellcheck="false" data-placeholder="Type filter: label:priority/low label:domain/inventory  (Enter to search, Tab to autocomplete)"></div>
            <div id="sr-smart-autocomplete" class="sr-smart-ac" hidden></div>
          </div>
          <!--
            Manual-entry: paste any GitHub issue URL or #number and hit
            Enter / Resolve.  Bypasses both the label-filter above AND
            the linked-PR filter in the picker below — lets the user
            resolve anything (including hidden issues) deliberately.
          -->
          <div id="sr-manual-row" style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;color:#9ca3af;">
            <span style="color:#6b7280;flex-shrink:0;">Or paste:</span>
            <input
              id="sr-manual-input"
              type="text"
              placeholder="Issue URL or #number  (e.g. https://github.com/shopware/shopware/issues/6689 or 6689)"
              style="flex:1;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:4px;padding:4px 8px;font-size:12px;"
              autocomplete="off"
              spellcheck="false" />
            <button id="sr-manual-run" class="sr-fetch-btn" style="flex-shrink:0;" disabled>Resolve</button>
          </div>
          <div id="sr-issue-picker" class="sr-issue-picker" style="display:none;"></div>
          <div id="sr-selected-count" class="sr-selected-count" style="display:none;"></div>
        </div>
      </div>

      <!-- Stepper + console (shown during resolve) -->
      <div class="sr-section" id="sr-resolve-panel" style="display:none;">
        <!-- Create-phase stepper.  Mirrors the 5 ### CREATE STEP N
             markers swctl create emits (preflight, worktree, sync,
             provision, frontend).  Visible during the create phase
             that precedes every resolve; fades to subdued once
             complete so the main 8-step resolve stepper below takes
             visual priority.
             NOTE: do not add backticks anywhere in this comment — it
             lives inside a JS template literal, so any backtick would
             terminate the literal and break the whole plugin parse. -->
        <div id="sr-create-stepper" class="sr-create-stepper">
          <div class="sr-create-step" data-create-step="1"><span class="sr-create-step-num">1</span><span class="sr-create-step-label">Pre-flight</span></div>
          <div class="sr-create-step" data-create-step="2"><span class="sr-create-step-num">2</span><span class="sr-create-step-label">Worktree</span></div>
          <div class="sr-create-step" data-create-step="3"><span class="sr-create-step-num">3</span><span class="sr-create-step-label">Sync</span></div>
          <div class="sr-create-step" data-create-step="4"><span class="sr-create-step-num">4</span><span class="sr-create-step-label">Provision</span></div>
          <div class="sr-create-step" data-create-step="5"><span class="sr-create-step-num">5</span><span class="sr-create-step-label">Frontend</span></div>
        </div>
        <div id="sr-stepper" class="sr-stepper">
          <div class="sr-step" data-step="1"><span class="sr-step-num">1</span><span class="sr-step-label">Verify</span></div>
          <div class="sr-step" data-step="2"><span class="sr-step-num">2</span><span class="sr-step-label">Root cause</span></div>
          <div class="sr-step" data-step="3"><span class="sr-step-num">3</span><span class="sr-step-label">Implement</span></div>
          <div class="sr-step" data-step="4"><span class="sr-step-num">4</span><span class="sr-step-label">Review</span></div>
          <div class="sr-step" data-step="5"><span class="sr-step-num">5</span><span class="sr-step-label">Flow impact</span></div>
          <div class="sr-step" data-step="6"><span class="sr-step-num">6</span><span class="sr-step-label">Test</span></div>
          <div class="sr-step" data-step="7"><span class="sr-step-num">7</span><span class="sr-step-label">PR</span></div>
          <div class="sr-step" data-step="8"><span class="sr-step-num">8</span><span class="sr-step-label">Triage</span></div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
          <div id="sr-step-info" style="color:#9ca3af;font-size:12px;flex:1;min-width:200px;"></div>
          <!-- Manual stop button.  Only visible while a resolve stream
               is open; hidden when stream closes (done or error).
               Click sends a POST to /api/stream/cancel with the
               resolve stream id, which SIGTERMs the agent process.
               The done handler sees the resulting exitCode and
               renders a "stopped manually" card variant. -->
          <button id="sr-stop-btn" type="button" style="display:none;font-size:11px;padding:3px 10px;border-radius:4px;border:1px solid #7f1d1d;background:#450a0a40;color:#f87171;cursor:pointer;font-family:ui-sans-serif,sans-serif;">🛑 Stop</button>
          <!-- Live token badge.  Updates from the server's tokens SSE
               event; hidden until the first event arrives.  Color shifts
               from gray (no budget) → green (under 50%) → amber (50-80%)
               → red (over 80%) as the running total approaches the cap.
               Reminder: no backticks anywhere here — would terminate
               the surrounding JS template literal. -->
          <div id="sr-tokens-badge" style="display:none;font-size:11px;font-family:ui-monospace,monospace;padding:3px 8px;border-radius:10px;border:1px solid #374151;background:#111827;color:#9ca3af;white-space:nowrap;"></div>
        </div>
        <div id="sr-result"></div>
        <div id="sr-console" class="sr-console"></div>
      </div>

      <!-- Issues & PRs table -->
      <div class="sr-section">
        <h3 class="sr-section-title">Issues &amp; PRs <span id="sr-table-loading" class="sr-loading"></span></h3>
        <div id="sr-table-container"></div>
      </div>
    </div>
  `

  // Wire create form
  const btn = el.querySelector('#sr-run')
  const fetchBtn = el.querySelector('#sr-fetch')
  const repoInput = el.querySelector('#sr-repo')
  const smartInput = el.querySelector('#sr-smart-input')
  const smartAc = el.querySelector('#sr-smart-autocomplete')
  const pickerEl = el.querySelector('#sr-issue-picker')
  const countEl = el.querySelector('#sr-selected-count')
  const out = el.querySelector('#sr-console')
  const resolvePanel = el.querySelector('#sr-resolve-panel')
  const stepInfo = el.querySelector('#sr-step-info')
  const stepperEl = el.querySelector('#sr-stepper')

  let currentStream = null
  let selectedIssues = new Set()

  // --- Smart filter: contenteditable with live token highlighting ---
  //
  // User types free-form tokens like `label:priority/low is:issue state:open`.
  // Each `key:value` token is highlighted inline with a key-specific colour.
  // Autocomplete drops down for the key/value currently under the caret.
  // Enter re-fetches; any `label:*` tokens become the allowlist passed to
  // /api/github/issues via the `labels=` query param.
  let defaultLabels = []
  let selectedLabels = []

  const SMART_KEYS = ['label', 'is', 'state', 'sort', 'assignee']
  const SMART_VALUES = {
    is: ['issue', 'pr'],
    state: ['open', 'closed'],
    sort: ['updated-desc', 'updated-asc', 'created-desc', 'created-asc'],
    assignee: ['@me'],
  }

  function tokenClass(key) {
    if (!key) return ''
    const k = key.toLowerCase()
    if (['label', 'is', 'state', 'sort', 'assignee'].includes(k)) return 'tk-' + k
    return ''
  }

  function tokenize(text) {
    const out = []
    const re = /\S+/g
    let m
    while ((m = re.exec(text)) !== null) {
      const raw = m[0]
      const colon = raw.indexOf(':')
      if (colon > 0 && colon < raw.length - 1) {
        out.push({ raw, key: raw.slice(0, colon), value: raw.slice(colon + 1), start: m.index, end: m.index + raw.length })
      } else {
        out.push({ raw, key: null, value: null, start: m.index, end: m.index + raw.length })
      }
    }
    return out
  }

  function renderHighlighted(text) {
    const tokens = tokenize(text)
    let html = ''
    let cur = 0
    for (const t of tokens) {
      if (cur < t.start) html += escape(text.slice(cur, t.start))
      if (t.key) {
        const cls = tokenClass(t.key)
        html += `<span class="sr-tok ${cls}"><span class="sr-tok-key">${escape(t.key)}:</span><span class="sr-tok-val">${escape(t.value)}</span></span>`
      } else {
        html += escape(t.raw)
      }
      cur = t.end
    }
    if (cur < text.length) html += escape(text.slice(cur))
    return html
  }

  function getCaretOffset(root) {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return 0
    const range = sel.getRangeAt(0)
    if (!root.contains(range.endContainer)) return 0
    const pre = range.cloneRange()
    pre.selectNodeContents(root)
    pre.setEnd(range.endContainer, range.endOffset)
    return pre.toString().length
  }

  function setCaretOffset(root, offset) {
    const sel = window.getSelection()
    const range = document.createRange()
    let remaining = offset
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      const len = node.textContent.length
      if (remaining <= len) {
        range.setStart(node, remaining)
        range.collapse(true)
        sel.removeAllRanges()
        sel.addRange(range)
        return
      }
      remaining -= len
      node = walker.nextNode()
    }
    // Fallback: caret at end
    range.selectNodeContents(root)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
  }

  function getText() { return smartInput.textContent || '' }

  function setText(text, caretAt) {
    smartInput.innerHTML = renderHighlighted(text)
    if (caretAt !== undefined) setCaretOffset(smartInput, caretAt)
  }

  function getCurrentWord() {
    const text = getText()
    const caret = getCaretOffset(smartInput)
    let start = caret
    while (start > 0 && !/\s/.test(text[start - 1])) start--
    return { word: text.slice(start, caret), start, end: caret }
  }

  function showAutocomplete() {
    if (defaultLabels.length === 0) { hideAutocomplete(); return }
    const { word } = getCurrentWord()
    if (!word) { hideAutocomplete(); return }
    const colon = word.indexOf(':')
    let suggestions = []
    if (colon === -1) {
      const p = word.toLowerCase()
      suggestions = SMART_KEYS
        .filter(k => k.toLowerCase().startsWith(p))
        .map(k => ({ display: `${k}:`, key: k, value: '' }))
    } else {
      const key = word.slice(0, colon).toLowerCase()
      const partial = word.slice(colon + 1).toLowerCase()
      const values = key === 'label' ? defaultLabels : (SMART_VALUES[key] || [])
      suggestions = values
        .filter(v => v.toLowerCase().includes(partial))
        .map(v => ({ display: `${key}:${v}`, key, value: v }))
    }
    if (suggestions.length === 0) { hideAutocomplete(); return }
    smartAc.innerHTML = suggestions.slice(0, 12).map((s, i) =>
      `<div class="sr-smart-ac-item${i === 0 ? ' active' : ''}" data-text="${escape(s.display)}">` +
        `<span class="sr-smart-ac-item-display"><span class="k">${escape(s.key)}:</span>${s.value ? `<span class="v">${escape(s.value)}</span>` : ''}</span>` +
        `<span class="sr-smart-ac-item-hint">${s.value ? '' : 'key'}</span>` +
      `</div>`,
    ).join('')
    smartAc.hidden = false
    smartAc.querySelectorAll('.sr-smart-ac-item').forEach(item => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
        const { start, end } = getCurrentWord()
        applySuggestion(item.dataset.text, start, end)
      })
    })
  }

  function hideAutocomplete() { smartAc.hidden = true }

  function applySuggestion(text, start, end) {
    const current = getText()
    const isPartialKey = !text.endsWith(':') && text.includes(':')
    const sep = isPartialKey ? ' ' : ''
    const newText = current.slice(0, start) + text + sep + current.slice(end)
    const caretAt = start + text.length + sep.length
    setText(newText, caretAt)
    hideAutocomplete()
    if (isPartialKey) submitQuery()
  }

  function submitQuery() {
    const tokens = tokenize(getText())
    selectedLabels = tokens
      .filter(t => t.key && t.key.toLowerCase() === 'label' && t.value)
      .map(t => t.value)
    fetchBtn.click()
  }

  smartInput.addEventListener('input', () => {
    const caret = getCaretOffset(smartInput)
    const text = getText()
    setText(text, caret)
    showAutocomplete()
  })

  smartInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      hideAutocomplete()
      submitQuery()
      return
    }
    if (e.key === 'Escape') { hideAutocomplete(); return }
    if (!smartAc.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      const items = [...smartAc.querySelectorAll('.sr-smart-ac-item')]
      if (items.length === 0) return
      const cur = items.findIndex(i => i.classList.contains('active'))
      const next = e.key === 'ArrowDown'
        ? Math.min(cur + 1, items.length - 1)
        : Math.max(cur - 1, 0)
      if (cur >= 0) items[cur].classList.remove('active')
      items[next].classList.add('active')
      return
    }
    if (e.key === 'Tab' && !smartAc.hidden) {
      e.preventDefault()
      const active = smartAc.querySelector('.sr-smart-ac-item.active')
      if (active) {
        const { start, end } = getCurrentWord()
        applySuggestion(active.dataset.text, start, end)
      }
    }
  })

  smartInput.addEventListener('blur', () => setTimeout(hideAutocomplete, 150))

  // Show a placeholder immediately so the picker area isn't blank during the
  // initial /labels/defaults + /github/issues round-trip (~2 s on cold cache).
  pickerEl.style.display = ''
  pickerEl.innerHTML = '<div style="padding:12px;color:#6b7280;font-size:12px;">Loading GitHub issues…</div>'

  // Load defaults and pre-fetch the filtered issue list on first paint.
  ;(async () => {
    try {
      const r = await fetch('/api/github/labels/defaults')
      const data = await r.json()
      defaultLabels = Array.isArray(data.labels) ? data.labels : []
      selectedLabels = defaultLabels.slice()
      const initial = defaultLabels.map(l => `label:${l}`).join(' ')
      setText(initial)
      if (defaultLabels.length > 0) {
        fetchBtn.click()
      } else {
        pickerEl.innerHTML = '<div style="padding:12px;color:#6b7280;font-size:12px;">No default labels configured. Type <code>label:…</code> above and click Fetch.</div>'
      }
    } catch (err) {
      pickerEl.innerHTML = `<div style="padding:12px;color:#f87171;font-size:12px;">Failed to load defaults: ${escape(err && err.message || String(err))}</div>`
    }
  })()

  function updateStepper(step, status) {
    stepperEl.querySelectorAll('.sr-step').forEach(s => {
      const n = parseInt(s.dataset.step)
      s.classList.remove('done', 'active', 'failed')
      if (status === 'failed' && n === step) {
        s.classList.add('failed')
      } else if (n < step) {
        s.classList.add('done')
      } else if (n === step) {
        s.classList.add('active')
      }
    })
  }

  // Sibling of updateStepper for the 5-step create-phase stepper.
  // Same semantics: <step= n active; <n done; failed marks just n.
  // Caller passes status='complete' to add the "fade subdued" class
  // once all 5 ### CREATE STEP N END markers have fired.
  const createStepperEl = el.querySelector('#sr-create-stepper')
  function updateCreateStepper(step, status) {
    if (!createStepperEl) return
    if (status === 'complete') {
      createStepperEl.classList.add('complete')
      createStepperEl.querySelectorAll('.sr-create-step').forEach(s => {
        s.classList.remove('active', 'failed')
        s.classList.add('done')
      })
      return
    }
    createStepperEl.classList.remove('complete')
    createStepperEl.querySelectorAll('.sr-create-step').forEach(s => {
      const n = parseInt(s.dataset.createStep)
      s.classList.remove('done', 'active', 'failed')
      if (status === 'failed' && n === step) {
        s.classList.add('failed')
      } else if (n < step) {
        s.classList.add('done')
      } else if (n === step) {
        s.classList.add('active')
      }
    })
  }
  function resetCreateStepper() {
    if (!createStepperEl) return
    createStepperEl.classList.remove('complete')
    createStepperEl.querySelectorAll('.sr-create-step').forEach(s => {
      s.classList.remove('done', 'active', 'failed')
    })
  }

  function updateSelectedCount() {
    if (selectedIssues.size === 0) {
      countEl.style.display = 'none'
      btn.disabled = true
      btn.textContent = 'Resolve selected'
    } else {
      countEl.style.display = ''
      countEl.textContent = `${selectedIssues.size} issue${selectedIssues.size !== 1 ? 's' : ''} selected`
      btn.disabled = false
      btn.textContent = `Resolve ${selectedIssues.size} issue${selectedIssues.size !== 1 ? 's' : ''}`
    }
  }

  // Fetch issues from GitHub
  fetchBtn.addEventListener('click', async () => {
    const repo = repoInput.value.trim() || 'shopware/shopware'
    fetchBtn.disabled = true
    fetchBtn.textContent = 'Fetching...'
    selectedIssues.clear()

    try {
      const params = new URLSearchParams({ repo })
      // Pass the label param whenever defaults are loaded (even if the user
      // has removed every chip — empty string = "no assigned issues shown").
      // Omitting the param entirely would bypass the filter, which is not
      // what the user wants here.
      if (defaultLabels.length > 0) params.set('labels', selectedLabels.join(','))
      const res = await fetch(`/api/github/issues?${params}`)
      const data = await res.json()
      const nonPrs = (data.items || []).filter(i => !i.isPR)

      // Two-stage filter, policy mirrored from
      // app/src/utils/filterResolvable.ts + tests in
      // tests/integration/filter_resolvable.bats — keep all three in sync.
      //
      // Stage 1 — onlyBug (default on): Resolve is scoped to fixing
      //   bugs.  Improvements, Stories, Tasks, or issues with no type
      //   are hidden here.  Case-insensitive match on issueType.  The
      //   manual-entry input below is the escape hatch for non-Bug
      //   issues.
      //
      // Stage 2 — no-active-linked-PR: hides issues whose linked PRs
      //   include an open/draft/merged PR (resolving them would
      //   duplicate in-flight or already-shipped work).  All-closed or
      //   no linkedPRs = fair game.
      //
      // Unknown future states are treated as active (safe default:
      // hide and force the user to override via manual entry rather
      // than risk duplicating work).
      const isBug = (it) => String(it.issueType || '').toLowerCase() === 'bug'
      const hasActivePr = (it) => {
        const prs = Array.isArray(it.linkedPRs) ? it.linkedPRs : []
        return prs.some(pr => pr && pr.state !== 'closed')
      }
      let hiddenByType = 0
      let hiddenByPr = 0
      const issues = nonPrs.filter((it) => {
        if (!isBug(it)) { hiddenByType++; return false }
        if (hasActivePr(it)) { hiddenByPr++; return false }
        return true
      })
      const hiddenCount = hiddenByType + hiddenByPr

      if (issues.length === 0) {
        const reasons = []
        if (hiddenByType > 0) reasons.push(`${hiddenByType} non-Bug`)
        if (hiddenByPr > 0)   reasons.push(`${hiddenByPr} already linked to a PR`)
        const hint = hiddenCount > 0
          ? `<div style="padding:12px;color:#6b7280;font-size:12px;">
               No resolvable Bug issues.
               <span style="display:block;margin-top:4px;color:#9ca3af;font-size:11px;">
                 (${reasons.join(', ')} hidden.
                 Paste the URL in the manual-entry input above to
                 resolve any issue anyway.)
               </span>
             </div>`
          : '<div style="padding:12px;color:#6b7280;font-size:12px;">No issues found.</div>'
        pickerEl.innerHTML = hint
        pickerEl.style.display = ''
        updateSelectedCount()
        return
      }

      pickerEl.style.display = ''
      let hiddenFooter = ''
      if (hiddenCount > 0) {
        const parts = []
        if (hiddenByType > 0) parts.push(`${hiddenByType} non-Bug`)
        if (hiddenByPr   > 0) parts.push(`${hiddenByPr} linked to a PR`)
        hiddenFooter = `<div style="padding:8px 12px;color:#6b7280;font-size:11px;font-style:italic;border-top:1px solid #1f2937;">
             ${parts.join(' · ')} hidden.
             Paste the URL in the manual-entry input to resolve any issue anyway.
           </div>`
      }
      // Render issue rows.  The #<number> is an <a> that opens the
      // issue on GitHub in a new tab (middle-click / cmd-click behaves
      // like any other link; normal click opens in a new tab and does
      // NOT toggle the row's checkbox — user request).  Row body still
      // acts as the checkbox-toggle target so the usual "click the
      // title to select" ergonomic stays.
      pickerEl.innerHTML = issues.map(i => {
        const issueUrl = i.url || (i.repo && i.number
          ? `https://github.com/${i.repo}/issues/${i.number}`
          : `https://github.com/shopware/shopware/issues/${i.number}`)
        return `
        <div class="sr-issue-row" data-number="${i.number}" data-url="${escape(issueUrl)}">
          <input type="checkbox" />
          <a class="sr-issue-num" href="${escape(issueUrl)}" target="_blank" rel="noopener noreferrer"
             title="Open #${i.number} on GitHub"
             style="color:#60a5fa;text-decoration:none;">#${i.number}</a>
          <span class="sr-issue-title">${escape(i.title)}</span>
          <span class="sr-issue-labels">${(i.labels || []).slice(0, 3).map(l =>
            `<span class="sr-issue-label" style="border-left:2px solid #${l.color || '666'}">${escape(l.name)}</span>`
          ).join('')}</span>
        </div>
      `
      }).join('') + hiddenFooter

      // Wire checkboxes
      pickerEl.querySelectorAll('.sr-issue-row').forEach(row => {
        const cb = row.querySelector('input[type=checkbox]')
        const num = row.dataset.number
        const url = row.dataset.url
        const numLink = row.querySelector('.sr-issue-num')

        row.addEventListener('click', (e) => {
          if (e.target === cb) return          // let checkbox handle itself
          // Clicking the #<number> link opens GitHub — don't also
          // toggle the row's checkbox.  Without this guard the row's
          // click handler would flip the selection state, which is
          // confusing (the user meant "go look at the issue", not
          // "queue it for resolve").
          if (numLink && (e.target === numLink || numLink.contains(e.target))) return
          cb.checked = !cb.checked
          cb.dispatchEvent(new Event('change'))
        })

        cb.addEventListener('change', () => {
          if (cb.checked) {
            selectedIssues.add(url || num)
            row.classList.add('selected')
          } else {
            selectedIssues.delete(url || num)
            row.classList.remove('selected')
          }
          updateSelectedCount()
        })
      })
    } catch (e) {
      pickerEl.innerHTML = `<div style="padding:12px;color:#f87171;font-size:12px;">Failed to fetch: ${escape(e.message)}</div>`
      pickerEl.style.display = ''
    } finally {
      fetchBtn.disabled = false
      fetchBtn.textContent = 'Fetch issues'
      updateSelectedCount()
    }
  })

  // ---- Manual-entry: paste any issue URL or #number and Resolve ----
  //
  // Bypasses both the label filter (above) and the linked-PR filter
  // (in the picker) — lets the user resolve anything deliberately.
  // Implementation: replace `selectedIssues` with a single-item set
  // and dispatch a click on the same btn handler.  Reuses the whole
  // existing batch pipeline (stepper, console, result card) without
  // duplicating its logic.
  const manualInput = el.querySelector('#sr-manual-input')
  const manualBtn   = el.querySelector('#sr-manual-run')

  // Normalize the input: GitHub URL, `owner/repo#N`, or plain `#N`/`N`.
  // Returns '' for input we can't turn into a stream argument.
  function normalizeIssueRef(raw) {
    const s = String(raw || '').trim()
    if (!s) return ''
    // Full GitHub URL: keep as-is (the server parses the `/issues/N` form).
    if (/^https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/.test(s)) return s
    // owner/repo#NNN
    const m1 = s.match(/^([^/\s]+)\/([^/\s#]+)#(\d+)$/)
    if (m1) return `https://github.com/${m1[1]}/${m1[2]}/issues/${m1[3]}`
    // #NNN  or  NNN  → use the repo field as the repo (default shopware/shopware).
    const m2 = s.match(/^#?(\d+)$/)
    if (m2) {
      const repo = (repoInput.value || 'shopware/shopware').trim()
      return `https://github.com/${repo}/issues/${m2[1]}`
    }
    return ''
  }

  const updateManualBtn = () => {
    manualBtn.disabled = !normalizeIssueRef(manualInput.value)
  }
  manualInput.addEventListener('input', updateManualBtn)
  manualInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !manualBtn.disabled) {
      e.preventDefault()
      manualBtn.click()
    }
  })

  manualBtn.addEventListener('click', () => {
    const url = normalizeIssueRef(manualInput.value)
    if (!url) return
    // Kick off a single-issue resolve by stashing the value in
    // selectedIssues and re-using the same btn click handler as the
    // "Resolve selected" button.
    selectedIssues.clear()
    selectedIssues.add(url)
    updateSelectedCount()
    // Visually deselect any picker rows so the user isn't surprised
    // that "selected" state is reset.
    pickerEl.querySelectorAll('.sr-issue-row.selected').forEach(r => {
      r.classList.remove('selected')
      const cb = r.querySelector('input[type=checkbox]')
      if (cb) cb.checked = false
    })
    btn.click()
    // Clear the input so a follow-up "Resolve" doesn't accidentally
    // fire on the same URL again.
    manualInput.value = ''
    updateManualBtn()
  })

  // ---- Backend dropdown ----------------------------------------------
  //
  // Reflects + persists `swctl.resolve.backend` in localStorage (same
  // key the dead Vue ResolvePage.vue used, kept stable for forward-
  // compat).  startStream / startStreamWithSteps read via getBackend()
  // and forward as ?backend= on the SSE URL.
  //
  // The available options are filtered by `ai.enabledBackends` from
  // `/api/user-config` — if the user disabled Codex in /#/config, this
  // dropdown won't even show it.  Default selection comes from the
  // server-side `resolved.defaultBackend` (which respects
  // ai.defaultBackend, falling back to first-enabled).  localStorage
  // wins iff the localStorage value is in the enabled set; otherwise
  // we fall back to the resolved default to avoid a stale "Codex" pick
  // surviving after the user disables it.
  const backendSel = el.querySelector('#sr-backend')
  if (backendSel) {
    ;(async () => {
      let enabled = ['claude']           // safe back-compat fallback
      let defaultBackend = 'claude'
      try {
        const res = await fetch('/api/user-config')
        if (res.ok) {
          const body = await res.json()
          if (body?.resolved?.enabledBackends?.length) {
            enabled = body.resolved.enabledBackends
          }
          if (body?.resolved?.defaultBackend) {
            defaultBackend = body.resolved.defaultBackend
          }
        }
      } catch {
        // /api/user-config unreachable (server still booting, etc.) →
        // fall through to the static [claude, codex] markup so the
        // dropdown stays usable.  No ?backend=codex will be sent if
        // claude is the selected value, so this is safe.
      }

      // Strip options not in the enabled set.
      Array.from(backendSel.options).forEach((opt) => {
        if (!enabled.includes(opt.value)) opt.remove()
      })
      // Hide the dropdown entirely when there's exactly one choice — a
      // 1-option <select> is just visual noise.
      if (enabled.length <= 1) {
        const label = backendSel.closest('.sr-backend-label')
        if (label) label.style.display = 'none'
      }

      // Reconcile localStorage with the enabled set: if the persisted
      // value is now disabled (e.g. user just turned off Codex), drop
      // it back to the resolved default.  Don't re-write LS until the
      // user explicitly picks something — keeps "their last pick"
      // sticky if they re-enable later.
      const persisted = getBackend()
      const initial = enabled.includes(persisted) ? persisted : defaultBackend
      if (enabled.includes(initial)) {
        backendSel.value = initial
      } else if (backendSel.options.length > 0) {
        backendSel.value = backendSel.options[0].value
      }

      backendSel.addEventListener('change', () => {
        setBackend(backendSel.value)
      })
    })()
  }

  // Wire the concurrency dropdown.  Value persists in localStorage
  // under `swctl.resolve.concurrency`.  `auto` resolves at click time
  // to half of navigator.hardwareConcurrency, clamped [1, 4] — a
  // safe-ish default that keeps FD pressure + OrbStack load bounded.
  const concSel = el.querySelector('#sr-concurrency')
  const LS_KEY = 'swctl.resolve.concurrency'
  const savedConc = (() => {
    try { return localStorage.getItem(LS_KEY) } catch { return null }
  })()
  if (savedConc && concSel.querySelector(`option[value="${savedConc}"]`)) {
    concSel.value = savedConc
  }
  concSel.addEventListener('change', () => {
    try { localStorage.setItem(LS_KEY, concSel.value) } catch {}
  })

  function resolveConcurrency() {
    const v = concSel.value
    if (v === 'auto') {
      const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4
      return Math.max(1, Math.min(4, Math.floor(hw / 2)))
    }
    const n = parseInt(v, 10)
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 2
  }

  // Resolve selected issues.  Up to N streams (from the dropdown) run
  // concurrently; the rest queue client-side and start as slots free.
  // The server's CreateQueue applies its own cap on the heavy
  // `swctl create` phase, so even aggressive settings here still
  // respect the server-side bound.
  btn.addEventListener('click', () => {
    if (selectedIssues.size === 0) return
    const issues = [...selectedIssues]
    const CONCURRENCY = resolveConcurrency()

    resolvePanel.style.display = ''
    out.textContent = ''
    // Two steppers visible: the create-phase one (5 steps, lights up
    // first as `swctl create` runs) and the resolve-workflow one (8
    // steps, lights up after the agent spawns).  Reset both on every
    // new run; the create stepper goes through 1→5 first, then the
    // resolve stepper handles 1→8.
    resetCreateStepper()
    updateCreateStepper(1, 'active')
    updateStepper(0, '')  // clear any stale state from a previous run
    stepInfo.textContent = `Resolving ${issues.length} issue${issues.length !== 1 ? 's' : ''} (max ${CONCURRENCY} at a time)…`
    btn.disabled = true
    btn.textContent = 'Running...'

    const repo = (repoInput.value || 'shopware/shopware').trim()
    const repoName = repo.split('/').pop() || ''
    const derivedProject = (repo === 'shopware/shopware' || !repoName) ? '' : repoName
    const resultEl = el.querySelector('#sr-result')
    resultEl.innerHTML = ''

    // Fixed-width concurrency pool.  `active` is the number of streams
    // currently connected; `pending` is the FIFO queue; `done` counts
    // completed (success or fail) so we know when the whole batch is over.
    const pending = issues.slice()
    let active = 0
    let done = 0
    const total = issues.length

    const updateBatchStatus = () => {
      const inflight = active
      const queued = pending.length
      const completed = done
      stepInfo.textContent = `Batch: ${completed}/${total} done · ${inflight} running · ${queued} queued`
    }

    const startNext = () => {
      while (active < CONCURRENCY && pending.length > 0) {
        const issueUrl = pending.shift()
        active++
        updateBatchStatus()
        appendLine(out, `\n=== Starting resolve for ${issueUrl} ===`, 'info')
        // Note: stepper visually tracks the LAST-started stream's step progression.
        // That's a minor compromise for batch mode; individual progress still lives
        // in the resolved-issues table below, refreshed on every finish.
        currentStream = startStreamWithSteps(
          issueUrl, derivedProject, 'qa',
          out, stepInfo, updateStepper, resultEl,
          (exitCode) => {
            active--
            done++
            appendLine(out, `=== ${issueUrl} finished (exit ${exitCode}) ===\n`, exitCode === 0 ? 'info' : 'err')
            paintTable()
            if (pending.length === 0 && active === 0) {
              btn.disabled = false
              btn.textContent = 'Resolve selected'
              stepInfo.textContent = `Batch complete: ${done}/${total}.`
            } else {
              updateBatchStatus()
              startNext()
            }
          },
          updateCreateStepper,  // wires the 5-step create-phase stepper to ### CREATE STEP markers
        )
      }
    }

    startNext()
  })

  // Wire issues table
  const tableContainer = el.querySelector('#sr-table-container')
  const tableLoading = el.querySelector('#sr-table-loading')

  // Initial placeholder so the table area isn't empty during the first fetch
  // (fetchInstances + N parallel fetchPr can take a few seconds on cold cache).
  tableContainer.innerHTML = '<div style="color:#6b7280;font-size:12px;padding:8px;">Loading resolved issues…</div>'

  // Prevent overlapping paints (15 s refresh timer can race a slow fetch).
  let painting = false

  async function paintTable() {
    if (painting) return
    painting = true
    tableLoading.textContent = '(loading...)'

    let instances
    try {
      instances = await fetchInstances()
    } catch (err) {
      tableContainer.innerHTML = `<div style="color:#f87171;font-size:12px;padding:8px;">Failed to load instances: ${escape(err && err.message || String(err))}</div>`
      tableLoading.textContent = ''
      painting = false
      return
    }

    // Show only instances with a real resolve transcript on disk.  An
    // instance created by `swctl create` (no resolve run yet) and
    // managed-but-pre-feature instances both have no session log to
    // show; surfacing them here was just noise.  `hasTranscript` is
    // computed server-side per instance in /api/instances.
    const resolveInstances = instances.filter(i =>
      i.kind === 'managed'
      && (i.branch?.startsWith('fix/') || i.branch?.startsWith('resolve/'))
      && i.hasTranscript === true
    )

    if (resolveInstances.length === 0) {
      tableContainer.innerHTML = '<div style="color:#6b7280;font-size:12px;padding:8px;">No resolved issues with transcripts yet. Run a resolve from the form above to populate this list.</div>'
      tableLoading.textContent = ''
      painting = false
      return
    }

    // Fetch PR info in one batched call (grouped by repo on the server).
    const prs = await fetchPrsBatch(resolveInstances.map(i => i.issueId))
    // Fetch all resolve-runs.json entries once and group by issue id;
    // attaches an `attempts` array to every item.  Used by the per-row
    // "📜 N" history button to render the modal without re-fetching.
    let runsByIssue = {}
    try {
      const runs = await fetchRuns()
      for (const run of runs) {
        const m = (run.issue || '').match(/(?:\/issues\/|#)(\d+)$/) || (run.issue || '').match(/^(\d+)$/)
        if (!m) continue
        const id = m[1]
        if (!runsByIssue[id]) runsByIssue[id] = []
        runsByIssue[id].push(run)
      }
      // Most recent first within each issue's list.
      for (const id of Object.keys(runsByIssue)) {
        runsByIssue[id].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
      }
    } catch {}
    const items = resolveInstances.map(inst => ({
      ...inst,
      pr: prs[inst.issueId] || null,
      attempts: runsByIssue[inst.issueId] || [],
    }))
    tableLoading.textContent = ''

    tableContainer.innerHTML = `
      <table class="sr-table">
        <thead>
          <tr>
            <th>Issue</th>
            <th>Branch</th>
            <th>AI</th>
            <th>Status</th>
            <th>PR</th>
            <th style="text-align:right;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(item => {
            const pr = item.pr
            const hasPr = pr && !pr.notFound && pr.number

            let statusHtml = '<span class="sr-pr-badge sr-pr-none">pending</span>'
            if (item.claudeResolveStatus === 'done' || (item.status === 'complete' && hasPr)) {
              statusHtml = '<span class="sr-pr-badge sr-pr-open">resolved</span>'
            } else if (item.claudeResolveStatus === 'running') {
              statusHtml = '<span class="sr-pr-badge" style="background:#1e3a5f;color:#60a5fa;">running</span>'
            } else if (item.claudeResolveStatus === 'failed' || item.status === 'failed') {
              statusHtml = '<span class="sr-pr-badge sr-pr-closed">failed</span>'
            } else if (item.status === 'complete') {
              statusHtml = '<span class="sr-pr-badge" style="background:#1f2937;color:#9ca3af;">complete</span>'
            }

            // Backend badge — Claude (orange/amber), Codex (purple),
            // unknown (gray dim).  Shape matches the existing sr-pr-badge
            // style but uses backend-specific colors so the eye can scan
            // the column quickly.
            let backendHtml = '<span class="sr-pr-badge sr-pr-none">—</span>'
            if (item.resolveBackend === 'claude') {
              backendHtml = '<span class="sr-pr-badge" style="background:rgba(217,119,6,0.18);color:#fbbf24;border:1px solid rgba(217,119,6,0.4);">Claude</span>'
            } else if (item.resolveBackend === 'codex') {
              backendHtml = '<span class="sr-pr-badge" style="background:rgba(124,58,237,0.18);color:#c084fc;border:1px solid rgba(124,58,237,0.4);">Codex</span>'
            }

            let prCell = '<span class="sr-pr-badge sr-pr-none">no PR</span>'
            if (hasPr) {
              const cls = pr.draft ? 'sr-pr-draft' : pr.state === 'MERGED' ? 'sr-pr-merged' : pr.state === 'CLOSED' ? 'sr-pr-closed' : 'sr-pr-open'
              const label = pr.draft ? 'DRAFT' : pr.state
              prCell = `<a href="${escape(pr.url)}" target="_blank" style="text-decoration:none;display:inline-flex;align-items:center;gap:4px;">
                <span class="sr-pr-badge ${cls}">${label}</span>
                <span style="color:#60a5fa;font-size:11px;">#${pr.number}</span>
              </a>`
            }

            const actions = []
            // Transcript button — render ONLY when a session log is
            // actually reachable for this issue.  Server computes
            // `hasTranscript` per instance in /api/instances by stat'ing
            // the relevant session-log path (Claude: ~/.claude/projects/
            // <encoded-cwd>/<sessionId>.jsonl; Codex: matching rollout in
            // ~/.codex/sessions/).  Hiding the button on rows without a
            // transcript avoids the "click → modal opens → 'No transcript
            // yet'" paper cut.
            if (item.hasTranscript) {
              actions.push(`<button class="sr-btn" data-transcript="${escape(item.issueId)}" title="View per-step transcript and token usage">📊</button>`)
            }
            // Run-history button — only render when there's something
            // to show (>= 1 recorded attempt).  Shows the count so users
            // can see at a glance whether this issue has a back-story
            // (#6689 had 6 attempts in the wild).  Click → modal with
            // per-attempt timestamp / backend / status / step / duration
            // / tokens.
            if (item.attempts && item.attempts.length > 0) {
              actions.push(`<button class="sr-btn" data-history="${escape(item.issueId)}" title="View all resolve attempts for this issue">📜 ${item.attempts.length}</button>`)
            }
            actions.push(`<button class="sr-btn" data-goto="/dashboard/instance/${escape(item.issueId)}" style="text-decoration:none;">Detail</button>`)
            actions.push(`<button class="sr-btn" data-action="push" data-issue="${escape(item.issueId)}">Push</button>`)
            if (!hasPr) {
              actions.push(`<button class="sr-btn sr-btn-primary" data-action="create" data-issue="${escape(item.issueId)}">Create PR</button>`)
            } else if (pr.draft) {
              actions.push(`<button class="sr-btn sr-btn-primary" data-action="ready" data-issue="${escape(item.issueId)}">Ready</button>`)
            }

            return `<tr>
              <td><span style="color:#60a5fa;font-weight:600;">#${escape(item.issueId)}</span></td>
              <td style="color:#9ca3af;font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escape(item.branch || '—')}</td>
              <td>${backendHtml}</td>
              <td>${statusHtml}</td>
              <td>${prCell}</td>
              <td style="text-align:right;display:flex;gap:4px;justify-content:flex-end;">${actions.join('')}</td>
            </tr>`
          }).join('')}
        </tbody>
      </table>
    `

    // Wire navigation buttons (data-goto)
    tableContainer.querySelectorAll('[data-goto]').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault()
        const target = btn.getAttribute('data-goto') || ''
        if (!target) return
        const clean = target.startsWith('/') ? target : `/${target}`
        location.assign(`${location.pathname}${location.search}#${clean}`)
        requestAnimationFrame(() => window.dispatchEvent(new HashChangeEvent('hashchange')))
      })
    })

    // Wire transcript buttons — opens the per-step modal for any issue
    // in the table, regardless of whether it just finished or shipped
    // weeks ago.  Result-card buttons are wired separately at the
    // resolve-stream completion site.
    tableContainer.querySelectorAll('[data-transcript]').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault()
        openTranscriptModal(btn.getAttribute('data-transcript'))
      })
    })

    // Wire history buttons — open the per-issue attempt log modal.
    // Pulls attempts from the closure's runsByIssue map (already
    // computed above) so the click is instant — no fetch.
    tableContainer.querySelectorAll('[data-history]').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault()
        const id = btn.getAttribute('data-history')
        openRunHistoryModal(id, runsByIssue[id] || [])
      })
    })

    // Wire action buttons
    tableContainer.querySelectorAll('.sr-btn[data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const action = e.target.dataset.action
        const issueId = e.target.dataset.issue
        const origText = e.target.textContent
        e.target.disabled = true
        e.target.textContent = '...'
        const result = await doPrAction(issueId, action)
        if (result.ok) {
          e.target.textContent = '✓'
          e.target.style.color = '#34d399'
          setTimeout(paintTable, 1500)
        } else {
          e.target.textContent = '✗'
          e.target.style.color = '#f87171'
          e.target.title = result.output || 'Failed'
          setTimeout(() => { e.target.textContent = origText; e.target.disabled = false; e.target.style.color = '' }, 3000)
        }
      })
    })

    painting = false
  }

  paintTable()
  const refreshTimer = setInterval(paintTable, 15000)

  return () => {
    clearInterval(refreshTimer)
    if (currentStream) try { currentStream.close() } catch {}
  }
}

// ---------- Widget: resolved issues with PR status ----------

async function fetchInstances() {
  try {
    const res = await fetch('/api/instances')
    return res.ok ? await res.json() : []
  } catch { return [] }
}

async function fetchPr(issueId) {
  try {
    const res = await fetch(`/api/skill/resolve/pr?issueId=${encodeURIComponent(issueId)}`)
    return res.ok ? await res.json() : null
  } catch { return null }
}

async function fetchPrsBatch(issueIds) {
  if (!issueIds || issueIds.length === 0) return {}
  try {
    const q = encodeURIComponent(issueIds.join(','))
    const res = await fetch(`/api/skill/resolve/pr/batch?issueIds=${q}`)
    return res.ok ? await res.json() : {}
  } catch { return {} }
}

async function doPrAction(issueId, action) {
  try {
    const res = await fetch(`/api/skill/resolve/pr/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueId }),
    })
    return res.ok ? await res.json() : { ok: false, output: 'Request failed' }
  } catch (e) { return { ok: false, output: e.message } }
}

function renderRecentRuns(el) {
  async function paint() {
    const instances = await fetchInstances()
    // Filter to instances with fix/resolve branches (created by resolve workflow)
    const resolveInstances = instances.filter(i =>
      i.kind === 'managed' && (i.branch?.startsWith('fix/') || i.branch?.startsWith('resolve/'))
    )

    if (resolveInstances.length === 0) {
      el.innerHTML = `<div style="color:#6b7280;font:12px ui-sans-serif,system-ui,sans-serif;">No resolved issues yet.</div>`
      return
    }

    // Fetch PR info for all instances in parallel
    const prPromises = resolveInstances.map(async (inst) => {
      const pr = await fetchPr(inst.issueId)
      return { ...inst, pr }
    })
    const items = await Promise.all(prPromises)

    el.innerHTML = `
      <style>
        .sr-issues { font: 12px ui-monospace, monospace; color: #e5e7eb; }
        .sr-issue-row {
          display: grid; grid-template-columns: 80px 1fr 160px 100px;
          align-items: center; gap: 8px; padding: 6px 4px;
          border-bottom: 1px solid #1f2937;
        }
        .sr-issue-row:hover { background: #111827; }
        .sr-pr-badge {
          display: inline-block; padding: 1px 6px; border-radius: 10px;
          font-size: 10px; font-weight: 600;
        }
        .sr-pr-open { background: #064e3b; color: #34d399; }
        .sr-pr-draft { background: #1f2937; color: #9ca3af; }
        .sr-pr-merged { background: #312e81; color: #a78bfa; }
        .sr-pr-closed { background: #450a0a; color: #f87171; }
        .sr-pr-none { background: #1f2937; color: #6b7280; }
        .sr-action-btn {
          background: #1f2937; border: 1px solid #374151; border-radius: 3px;
          color: #9ca3af; font: 10px ui-sans-serif, sans-serif; padding: 2px 6px;
          cursor: pointer;
        }
        .sr-action-btn:hover { background: #374151; color: #e5e7eb; }
      </style>
      <div class="sr-issues">
        <div class="sr-issue-row" style="color:#6b7280;font-weight:600;border-bottom:2px solid #1f2937;">
          <span>Issue</span>
          <span>Branch</span>
          <span>PR</span>
          <span>Actions</span>
        </div>
        ${items.map(item => {
          const pr = item.pr
          const hasPr = pr && !pr.notFound && pr.number
          let prBadge = '<span class="sr-pr-badge sr-pr-none">no PR</span>'
          let prLink = ''
          if (hasPr) {
            const cls = pr.draft ? 'sr-pr-draft' : pr.state === 'MERGED' ? 'sr-pr-merged' : pr.state === 'CLOSED' ? 'sr-pr-closed' : 'sr-pr-open'
            const label = pr.draft ? 'DRAFT' : pr.state
            prBadge = `<span class="sr-pr-badge ${cls}">${label}</span>`
            prLink = `<a href="${escape(pr.url)}" target="_blank" style="color:#60a5fa;text-decoration:none;margin-left:4px;">#${pr.number}</a>`
          }
          const actions = hasPr
            ? `<button class="sr-action-btn" data-action="push" data-issue="${escape(item.issueId)}" title="Push latest">Push</button>
               <button class="sr-action-btn" data-action="merge" data-issue="${escape(item.issueId)}" title="Squash merge">Merge</button>`
            : `<button class="sr-action-btn" data-action="push" data-issue="${escape(item.issueId)}" title="Push branch">Push</button>
               <button class="sr-action-btn" data-action="create" data-issue="${escape(item.issueId)}" title="Create draft PR">Create PR</button>`

          return `
            <div class="sr-issue-row">
              <span style="color:#60a5fa;font-weight:600;">#${escape(item.issueId)}</span>
              <span style="color:#9ca3af;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escape(item.branch || '—')}</span>
              <span>${prBadge}${prLink}</span>
              <span>${actions}</span>
            </div>
          `
        }).join('')}
      </div>
    `

    // Wire up action buttons
    el.querySelectorAll('.sr-action-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const action = e.target.dataset.action
        const issueId = e.target.dataset.issue
        e.target.disabled = true
        e.target.textContent = '...'
        const result = await doPrAction(issueId, action)
        if (result.ok) {
          e.target.textContent = '✓'
          e.target.style.color = '#34d399'
          // Refresh after a short delay
          setTimeout(paint, 1500)
        } else {
          e.target.textContent = '✗'
          e.target.style.color = '#f87171'
          e.target.title = result.output || 'Failed'
        }
      })
    })
  }

  paint()
  const timer = setInterval(paint, 10000)
  return () => { clearInterval(timer) }
}

function statusIcon(s) {
  if (s === 'running') return '⏳'
  if (s === 'done') return '✅'
  return '❌'
}

function shortIssue(s) {
  const m = /\/issues\/(\d+)/.exec(s)
  if (m) return `#${m[1]}`
  return s.length > 50 ? s.slice(0, 47) + '…' : s
}

function timeAgo(iso) {
  if (!iso) return ''
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// ---------- Action: "Resolve with Claude" on instance rows ----------

const plugin = {
  id: 'shopware-resolve',

  routes: [
    {
      path: '/resolve',
      label: 'Resolve',
      icon: '🩺',
      render: renderResolvePage,
    },
  ],

  widgets: [],

  // No row-level actions for now — the /resolve page is the single entry
  // point for triggering a resolve. Keeping row actions empty avoids cluttering
  // the instance list with buttons that would require state we don't track.
  actions: [],
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

// ─── Browser notifications on long-run completion ──────────────────────────
//
// Resolve runs take 5-25 minutes for Codex / 3-10 for Claude.  Users
// reasonably want to walk away (other windows, lunch, another task) and
// come back when the run finishes.  The result card already exists, but
// the user doesn't see it unless they're focused on the resolve tab.
//
// Strategy:
//   - Lazily request permission on the FIRST resolve start (one-time
//     browser prompt); user grants or denies; choice sticks via the
//     browser's permissions store.
//   - On `done`, fire a notification ONLY when the tab is in the
//     background (document.hidden = true).  No need to interrupt a
//     user who's already looking at the result.
//   - Notification body distinguishes the three terminal states:
//     resolved / failed / budget-exceeded.  Click focuses the tab.
//
// All operations no-op gracefully when:
//   - The Notification API isn't available (old browser, embedded view)
//   - Permission was denied — we don't beg
//   - The tab is in the foreground

function maybeRequestNotificationPermission() {
  if (typeof window === 'undefined' || !('Notification' in window)) return
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {})
  }
}

function notifyResolveDone(opts) {
  if (typeof window === 'undefined' || !('Notification' in window)) return
  if (Notification.permission !== 'granted') return
  if (typeof document !== 'undefined' && !document.hidden) return  // user is focused; no need

  const { issueId, status, durationMs, stepsCompleted, tokensTotal } = opts
  const titleByStatus = {
    'done':            '✅ Resolve complete',
    'failed':          '❌ Resolve failed',
    'budget-exceeded': '🪙 Token budget hit',
  }
  const title = titleByStatus[status] || 'Resolve finished'
  const minutes = Math.round((durationMs || 0) / 60000)
  const fmtTok = (n) => n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M'
                      : n >= 1_000 ? (n / 1_000).toFixed(0) + 'K'
                      : String(n)
  const parts = [`Issue #${issueId}`]
  if (stepsCompleted != null) parts.push(`${stepsCompleted}/8 steps`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (tokensTotal) parts.push(`${fmtTok(tokensTotal)} tokens`)

  try {
    const n = new Notification(title, {
      body: parts.join(' • '),
      // tag dedupes — if the user re-runs the same issue in the
      // background, only the latest notification stays.
      tag: `swctl-resolve-${issueId}`,
      requireInteraction: false,
    })
    n.onclick = () => {
      window.focus()
      n.close()
    }
    // Auto-dismiss after 15s — Chrome ignores this and keeps it until
    // the user clicks, but Firefox honours it.  No harm either way.
    setTimeout(() => { try { n.close() } catch {} }, 15000)
  } catch {
    // Browser may throw if the user is in a private window with
    // restricted permissions, etc.  Silent best-effort.
  }
}

// ─── Transcript modal ───────────────────────────────────────────────────────
//
// Reads /api/skill/resolve/transcript?issueId=N and renders the per-step
// breakdown in a centered overlay modal.  Header strip shows totals
// (tokens in/out, cached, reasoning, cost, duration); body is an
// accordion of steps, each toggle-able.  Esc / background-click /
// X-button closes; the modal owns its own DOM so multiple instances
// don't stack.  Idempotent — calling it twice just rebuilds the
// modal content.

function fmtTokens(n) {
  return n > 0 ? n.toLocaleString() : '—'
}

function fmtCost(usd) {
  if (usd === null || usd === undefined) return '—'
  return '$' + Number(usd).toFixed(2)
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60), rs = s % 60
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`
  const h = Math.floor(m / 60), rm = m % 60
  return rm ? `${h}h ${rm}m` : `${h}h`
}

function stepHeading(s) {
  if (s.step === 0) return 'Preamble'
  return s.name ? `Step ${s.step}: ${s.name}` : `Step ${s.step}`
}

async function openTranscriptModal(issueId) {
  // Tear down any prior modal so we never stack.
  document.querySelectorAll('.sr-tr-overlay').forEach((n) => n.remove())

  // Inject styles once.
  if (!document.getElementById('sr-tr-styles')) {
    const style = document.createElement('style')
    style.id = 'sr-tr-styles'
    style.textContent = `
      .sr-tr-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 24px; }
      .sr-tr-modal { background: #0f172a; border: 1px solid #1f2937; border-radius: 8px; width: min(1000px, 100%); max-height: 90vh; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
      .sr-tr-head  { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid #1f2937; }
      .sr-tr-title { font: 600 14px ui-sans-serif, sans-serif; color: #e5e7eb; }
      .sr-tr-close { margin-left: auto; background: transparent; border: none; color: #9ca3af; font-size: 18px; cursor: pointer; padding: 4px 8px; border-radius: 4px; }
      .sr-tr-close:hover { background: #1f2937; color: #fff; }
      .sr-tr-totals { padding: 10px 18px; border-bottom: 1px solid #1f2937; background: #111827; font: 11px ui-monospace, monospace; color: #9ca3af; display: flex; flex-wrap: wrap; gap: 4px 16px; }
      .sr-tr-totals .lbl { color: #6b7280; }
      .sr-tr-totals .num-in   { color: #60a5fa; }
      .sr-tr-totals .num-out  { color: #34d399; }
      .sr-tr-totals .num-cached  { color: #6b7280; }
      .sr-tr-totals .num-reason  { color: #c084fc; }
      .sr-tr-totals .num-cost    { color: #fbbf24; }
      .sr-tr-totals .right    { margin-left: auto; color: #6b7280; }
      .sr-tr-body  { flex: 1; overflow: auto; }
      .sr-tr-empty { padding: 32px 18px; color: #9ca3af; font-size: 13px; text-align: center; }
      .sr-tr-step  { border-bottom: 1px solid #1f2937; }
      .sr-tr-step:last-child { border-bottom: none; }
      .sr-tr-step-head {
        display: grid; grid-template-columns: 14px minmax(0, 1fr) 60px 60px 90px 90px 80px;
        gap: 12px; align-items: center;
        padding: 10px 18px; cursor: pointer; transition: background 0.1s;
        background: transparent; border: none; width: 100%; text-align: left;
        font: inherit; color: inherit;
      }
      .sr-tr-step-head:hover { background: #111827; }
      .sr-tr-step-caret { color: #6b7280; font-size: 11px; }
      .sr-tr-step-name  { color: #e5e7eb; font: 600 13px ui-sans-serif, sans-serif; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sr-tr-step-meta  { font: 11px ui-monospace, monospace; color: #6b7280; text-align: right; }
      .sr-tr-step-tok-in   { font: 11px ui-monospace, monospace; color: #60a5fa; text-align: right; }
      .sr-tr-step-tok-out  { font: 11px ui-monospace, monospace; color: #34d399; text-align: right; }
      .sr-tr-step-tok-total{ font: 600 12px ui-monospace, monospace; color: #fbbf24; text-align: right; }
      /* Per-step token panel inside the expanded body — most prominent
         place for "what did this step cost" so it's hard to miss. */
      .sr-tr-step-tok-panel {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 8px 16px; margin: 0 0 10px 0; padding: 10px 14px;
        background: #1e2a3d; border: 1px solid #1e293b; border-radius: 6px;
      }
      .sr-tr-tok-cell { display: flex; flex-direction: column; gap: 2px; }
      .sr-tr-tok-cell .lbl { font: 10px ui-sans-serif, sans-serif; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
      .sr-tr-tok-cell .val { font: 600 14px ui-monospace, monospace; }
      .sr-tr-tok-cell .val.in   { color: #60a5fa; }
      .sr-tr-tok-cell .val.out  { color: #34d399; }
      .sr-tr-tok-cell .val.cached { color: #9ca3af; }
      .sr-tr-tok-cell .val.reason { color: #c084fc; }
      .sr-tr-tok-cell .val.total  { color: #fbbf24; }
      .sr-tr-tok-cell .val.dim { color: #6b7280; font-style: italic; font-weight: 400; }
      .sr-tr-step-body  { padding: 8px 18px 14px 18px; background: #0a1020; border-top: 1px solid #1f2937; max-height: 360px; overflow: auto; }
      .sr-tr-line { font: 11px/1.55 ui-monospace, monospace; color: #cbd5e1; white-space: pre-wrap; word-break: break-word; margin: 0; }
    `
    document.head.appendChild(style)
  }

  // Build the modal scaffold up front so we can show "Loading…" while we
  // fetch.  Avoids a flash of empty modal on slow networks.
  const overlay = document.createElement('div')
  overlay.className = 'sr-tr-overlay'
  overlay.innerHTML = `
    <div class="sr-tr-modal" role="dialog" aria-label="Resolve transcript for #${escape(issueId)}">
      <div class="sr-tr-head">
        <span class="sr-tr-title">Transcript — Issue #${escape(issueId)}</span>
        <button class="sr-tr-close" aria-label="Close">✕</button>
      </div>
      <div class="sr-tr-totals" id="sr-tr-totals">Loading…</div>
      <div class="sr-tr-body" id="sr-tr-body"></div>
    </div>
  `
  document.body.appendChild(overlay)

  const close = () => overlay.remove()
  overlay.querySelector('.sr-tr-close').addEventListener('click', close)
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) close()
  })
  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      close()
      document.removeEventListener('keydown', onKey)
    }
  }
  document.addEventListener('keydown', onKey)

  // Fetch + render.
  let data
  try {
    const res = await fetch(`/api/skill/resolve/transcript?issueId=${encodeURIComponent(issueId)}`)
    data = await res.json()
  } catch (err) {
    overlay.querySelector('#sr-tr-totals').textContent = ''
    overlay.querySelector('#sr-tr-body').innerHTML =
      `<div class="sr-tr-empty">Failed to load transcript: ${escape(String(err && err.message || err))}</div>`
    return
  }

  if (!data || !Array.isArray(data.steps) || data.steps.length === 0) {
    overlay.querySelector('#sr-tr-totals').textContent = ''
    overlay.querySelector('#sr-tr-body').innerHTML = `
      <div class="sr-tr-empty">
        No transcript yet.<br>
        <span style="color:#6b7280;font-size:11px;">
          Transcripts started recording in v0.5.9. Earlier runs don't have one;
          the next time you resolve this issue, every line is captured here.
        </span>
      </div>`
    return
  }

  // Totals strip.
  const t = data.totals.tokens
  const totalsEl = overlay.querySelector('#sr-tr-totals')
  totalsEl.innerHTML = `
    <span class="lbl">Total:</span>
    <span><span class="num-in">${escape(fmtTokens(t.input))}</span> in</span>
    ${t.cachedInput > 0 ? `<span><span class="num-cached">${escape(fmtTokens(t.cachedInput))}</span> cached</span>` : ''}
    <span><span class="num-out">${escape(fmtTokens(t.output))}</span> out</span>
    ${t.reasoning > 0 ? `<span><span class="num-reason">${escape(fmtTokens(t.reasoning))}</span> reasoning</span>` : ''}
    ${data.totals.costUsd !== null ? `<span><span class="num-cost">${escape(fmtCost(data.totals.costUsd))}</span></span>` : ''}
    <span class="right">${escape(fmtDuration(data.totals.durationMs))} · ${data.totals.lineCount} lines</span>
  `

  // Per-step accordion.  Auto-expand the highest-numbered step (most
  // recent activity); rest are collapsed until the user clicks.
  const body = overlay.querySelector('#sr-tr-body')
  const lastStep = data.steps[data.steps.length - 1]
  const initialOpen = lastStep ? lastStep.step : -1

  for (const step of data.steps) {
    const stepEl = document.createElement('div')
    stepEl.className = 'sr-tr-step'
    const isOpen = step.step === initialOpen
    // "Total" tokens for the header summary — sum across input + cached
    // + output + reasoning so the user gets ONE big number per step
    // that captures total work, not just the ~uncached subset.
    const totalTokens = step.tokens.input + step.tokens.cachedInput + step.tokens.output + step.tokens.reasoning
    stepEl.innerHTML = `
      <button class="sr-tr-step-head" type="button">
        <span class="sr-tr-step-caret">${isOpen ? '▾' : '▸'}</span>
        <span class="sr-tr-step-name">${escape(stepHeading(step))}</span>
        <span class="sr-tr-step-meta">${escape(String(step.lines.length))} lines</span>
        <span class="sr-tr-step-meta">${escape(fmtDuration(step.durationMs))}</span>
        <span class="sr-tr-step-tok-in">${escape(fmtTokens(step.tokens.input))} in</span>
        <span class="sr-tr-step-tok-out">${escape(fmtTokens(step.tokens.output))} out</span>
        <span class="sr-tr-step-tok-total">Σ ${escape(fmtTokens(totalTokens))}</span>
      </button>
      <div class="sr-tr-step-body" style="${isOpen ? '' : 'display:none;'}">
        ${renderStepTokenPanel(step.tokens)}
        ${step.lines.map((row) => `<pre class="sr-tr-line">${escape(row.line)}</pre>`).join('')}
      </div>
    `
    const head = stepEl.querySelector('.sr-tr-step-head')
    const bodyEl = stepEl.querySelector('.sr-tr-step-body')
    const caret = stepEl.querySelector('.sr-tr-step-caret')
    head.addEventListener('click', () => {
      const showing = bodyEl.style.display !== 'none'
      bodyEl.style.display = showing ? 'none' : ''
      caret.textContent = showing ? '▸' : '▾'
    })
    body.appendChild(stepEl)
  }
}

/**
 * Render a card with five token cells (input / cached / output /
 * reasoning / total) shown prominently at the top of a step's
 * expanded body.  The header columns are a glance-at summary; this
 * panel is the authoritative per-step breakdown — no scanning the
 * narrow header columns required.
 */
function renderStepTokenPanel(tokens) {
  const total = tokens.input + tokens.cachedInput + tokens.output + tokens.reasoning
  const cell = (lbl, value, cls, extra) => `
    <div class="sr-tr-tok-cell">
      <span class="lbl">${escape(lbl)}</span>
      <span class="val ${cls}">${value > 0 ? escape(fmtTokens(value)) : '<span class="dim">—</span>'}${extra ? ` <span class="dim" style="font-size:11px;font-weight:400;">${extra}</span>` : ''}</span>
    </div>`
  // Cache-hit ratio — useful diagnostic for "is this step paying for
  // re-reading context I already paid for".
  const cacheRatio = (tokens.input + tokens.cachedInput) > 0
    ? Math.round(100 * tokens.cachedInput / (tokens.input + tokens.cachedInput))
    : 0
  return `
    <div class="sr-tr-step-tok-panel">
      ${cell('Input',   tokens.input,       'in')}
      ${cell('Cached',  tokens.cachedInput, 'cached', cacheRatio > 0 ? `(${cacheRatio}% hit)` : '')}
      ${cell('Output',  tokens.output,      'out')}
      ${cell('Reasoning', tokens.reasoning, 'reason')}
      ${cell('Total Σ',  total,             'total')}
    </div>`
}

// Expose on window for ad-hoc console invocation:
//   openTranscriptModal('6689')
// Useful when debugging or when the user wants to view the transcript
// for an issue that doesn't currently have a result-card on screen.
if (typeof window !== 'undefined') {
  window.openTranscriptModal = openTranscriptModal
}

// ─── Run-history modal ──────────────────────────────────────────────────────
//
// Opens a centered overlay listing every recorded resolve attempt for
// one issue (from resolve-runs.json, already fetched + grouped in the
// table-paint code path).  Issue #6689 in our test corpus had 6
// attempts; only the most recent was visible in the table before this.
//
// Each attempt row shows: timestamp + relative-time, backend (Claude /
// Codex), status pill (done / failed / budget-exceeded / running),
// step reached (X/8), duration, total tokens (when recorded).
//
// Reuses the .sr-tr-* class family from the transcript modal so the
// two modals look like siblings.

function openRunHistoryModal(issueId, attempts) {
  document.querySelectorAll('.sr-tr-overlay').forEach((n) => n.remove())

  const overlay = document.createElement('div')
  overlay.className = 'sr-tr-overlay'

  const fmtRelative = (iso) => {
    if (!iso) return '—'
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return '—'
    const sec = Math.round((Date.now() - t) / 1000)
    if (sec < 60) return `${sec}s ago`
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`
    if (sec < 86400) return `${Math.round(sec / 3600)}h ago`
    return `${Math.round(sec / 86400)}d ago`
  }
  const fmtDur = (a, b) => {
    const sa = Date.parse(a || '')
    const sb = Date.parse(b || '')
    if (!Number.isFinite(sa) || !Number.isFinite(sb)) return '—'
    const s = Math.max(0, Math.round((sb - sa) / 1000))
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60), rs = s % 60
    return rs ? `${m}m ${rs}s` : `${m}m`
  }
  const fmtTok = (n) => {
    if (n == null || !Number.isFinite(Number(n))) return '—'
    const v = Number(n)
    return v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + 'M'
         : v >= 1_000 ? (v / 1_000).toFixed(0) + 'K'
         : String(v)
  }
  const statusBadge = (s) => {
    const colors = {
      'done':            'background:#064e3b40;color:#34d399;border:1px solid #065f4660;',
      'failed':          'background:#450a0a40;color:#f87171;border:1px solid #7f1d1d60;',
      'budget-exceeded': 'background:#78350f40;color:#fbbf24;border:1px solid #b4530960;',
      'running':         'background:#1e3a5f40;color:#60a5fa;border:1px solid #1e40af60;',
    }
    return `<span style="${colors[s] || 'background:#1f2937;color:#9ca3af;'}padding:1px 6px;border-radius:3px;font-size:10px;">${escape(s || 'unknown')}</span>`
  }
  const backendBadge = (b) => {
    if (b === 'claude') return '<span style="color:#fbbf24;font-size:11px;">Claude</span>'
    if (b === 'codex')  return '<span style="color:#c084fc;font-size:11px;">Codex</span>'
    return '<span style="color:#6b7280;font-size:11px;">—</span>'
  }

  const rows = attempts.map((a) => `
    <tr style="border-bottom:1px solid #1f2937;">
      <td style="padding:8px 12px;font-size:11px;color:#9ca3af;font-family:ui-monospace,monospace;white-space:nowrap;">${escape((a.startedAt || '').slice(0, 19).replace('T', ' '))}<br><span style="color:#6b7280;">${escape(fmtRelative(a.startedAt))}</span></td>
      <td style="padding:8px 12px;">${backendBadge(a.backend)}</td>
      <td style="padding:8px 12px;">${statusBadge(a.status)}</td>
      <td style="padding:8px 12px;font-size:11px;color:#d1d5db;font-family:ui-monospace,monospace;">${a.lastCompletedStep != null ? `${a.lastCompletedStep}/8` : '—'}</td>
      <td style="padding:8px 12px;font-size:11px;color:#d1d5db;font-family:ui-monospace,monospace;">${escape(fmtDur(a.startedAt, a.finishedAt))}</td>
      <td style="padding:8px 12px;font-size:11px;color:#60a5fa;font-family:ui-monospace,monospace;">${escape(fmtTok(a.tokensTotal))}</td>
      <td style="padding:8px 12px;font-size:10px;color:#6b7280;">${a.exitCode != null ? `exit ${a.exitCode}` : ''}</td>
    </tr>
  `).join('')

  overlay.innerHTML = `
    <div class="sr-tr-modal" role="dialog" aria-label="Run history for #${escape(issueId)}">
      <div class="sr-tr-head">
        <span class="sr-tr-title">Run history — Issue #${escape(issueId)}</span>
        <span style="color:#6b7280;font-size:11px;margin-left:8px;">${attempts.length} attempt${attempts.length === 1 ? '' : 's'}</span>
        <button class="sr-tr-close" aria-label="Close">✕</button>
      </div>
      ${attempts.length === 0
        ? '<div class="sr-tr-empty">No recorded attempts.</div>'
        : `<div style="overflow:auto;flex:1;">
            <table style="width:100%;border-collapse:collapse;">
              <thead>
                <tr style="background:#111827;">
                  <th style="text-align:left;padding:8px 12px;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Started</th>
                  <th style="text-align:left;padding:8px 12px;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">AI</th>
                  <th style="text-align:left;padding:8px 12px;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Status</th>
                  <th style="text-align:left;padding:8px 12px;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Steps</th>
                  <th style="text-align:left;padding:8px 12px;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Duration</th>
                  <th style="text-align:left;padding:8px 12px;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Tokens</th>
                  <th style="text-align:left;padding:8px 12px;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Exit</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`
      }
    </div>
  `
  document.body.appendChild(overlay)

  const close = () => overlay.remove()
  overlay.querySelector('.sr-tr-close').addEventListener('click', close)
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close() })
  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      close()
      document.removeEventListener('keydown', onKey)
    }
  }
  document.addEventListener('keydown', onKey)
}

if (typeof window !== 'undefined') {
  window.openRunHistoryModal = openRunHistoryModal
}

export default plugin
