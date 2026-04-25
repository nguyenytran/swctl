---
name: shopware-resolve
description: >-
  Shopware 6 issue resolution workflow: triage, root-cause analysis, fix implementation,
  independent review, Flow Builder impact assessment, validation, and PR preparation.
  Use for bugs, regressions, performance issues, plugin/app conflicts, migration failures,
  search behavior, or any Shopware platform issue that needs structured investigation and fix.
---

# Shopware Resolve

Structured 8-step workflow to take a Shopware issue from report to merge-ready fix.

## Ground rules (apply to every step)

These rules are mandatory regardless of how the skill is invoked —
whether a human is driving with `claude` interactively, or swctl is
running you non-interactively via `-p`. They keep the transcript
scannable and let tooling (swctl UI, stepper, coverage banner)
confirm every step actually ran.

1. **Emit step markers on their own line.** Start each step with
   `### STEP <N> START: <name>` and end it with `### STEP <N> END`
   once the step's required artifact exists. The swctl UI parses
   these to light up the stepper and flag incomplete runs.
2. **Produce the required artifact per step (below).** A step is not
   complete until its artifact exists — not "I would do X" but "I did
   X, here's the output". Do not skip or abbreviate steps.
3. **Proceed through every step unless explicitly blocked.** If no
   human is available (e.g. running under `claude -p`), do not pause
   for approval — move on to the next step once the current step's
   artifact is produced. Interactive runs may still offer gates to
   the human between steps, but the transcript structure is the
   same.
4. **Step 5 "Provision environment" is required before Step 6.** The
   worktree is created without provisioning (no DB, no container) so
   Claude only pays the setup cost after the fix has been reviewed.
   Invoke `bash /swctl/swctl refresh <issue-id>` (or
   `swctl refresh <issue-id>` from `$PATH`) to bring up the
   container. Do NOT run this before Step 4's review returns PASS or
   CONCERNS; if Step 4 returns BLOCK, jump straight to Step 8 and
   stop.
5. **Step 3 must commit.** Run `git add -A && git commit -m
   "<conventional msg>"` on the current branch inside the worktree
   (or nested plugin dir for plugin-external projects). Skip the
   commit only if you concluded no code change is needed; then state
   the reason in the Step 8 summary.
6. **Step 7 prepares the PR but never opens it. No exceptions.** Run
   `scripts/prepare-pr.sh` and leave the PR body at `/tmp/pr-body.md`
   so the user can attach it. Do NOT call `scripts/create-pr.sh`, do
   NOT `git push`, do NOT `gh pr create`, do NOT push branches to any
   remote. The user pushes and opens the PR themselves from the swctl
   UI / dashboard — this is non-negotiable even if the user seems to
   ask for "just push it" as a one-off. Instead, remind them the swctl
   UI is the designated path and stop at local commit + PR body.
7. **Route to the correct repo using GitHub labels, not intuition.**
   Before Step 3 commits anything, inspect the issue's labels
   (`gh issue view <n> --json labels`). An `extension/*` label means
   the fix belongs in that plugin's repo — NOT in `shopware/shopware`
   trunk. The two you will encounter in practice are:

   - `extension/Custom-Products` → `shopware/SwagCustomizedProducts`,
     checked out at `custom/plugins/SwagCustomizedProducts`
   - `extension/Commercial` → `shopware/SwagCommercial`, checked out
     at `custom/plugins/SwagCommercial`

   For any other `extension/<Name>` label, look it up on GitHub
   (`gh search repos "in:name <Name>" --owner shopware`) before
   guessing — do not invent a repo path. Issues with no `extension/*`
   label are fixed in core trunk. Never add, remove, or rename the
   `extension/*` label on the issue; it is maintainer-curated scope.
   Getting this wrong means the PR targets the wrong repo and has to
   be redone — always read labels first.
8. **Do not add changelog entries.** Do NOT edit
   `CHANGELOG.md` (plugin repos) and do NOT create files under
   `changelog/_unreleased/` (shopware/shopware trunk). This applies to
   both platform and plugin fixes. Changelogs are consolidated into a
   single release PR separately from individual fix PRs. Add a
   changelog entry only if the user explicitly asks for it in the
   current conversation — never by default, not even when the PR body
   template suggests it. If you have already added one, remove it
   before committing.

## Required artifact per step

| Step | Required artifact |
|---|---|
| 1 Verify | Reproduction scenario + verdict: `REPRODUCED` / `NOT_REPRODUCED` / `PARTIALLY_REPRODUCED`. |
| 2 Root cause | A paragraph labeled "Root cause hypothesis:" with file paths + line refs as evidence. |
| 3 Implement | At least one Edit tool call AND a `git commit`. If no code change is needed, state the reason explicitly. |
| 4 Review | A Task-spawned review sub-agent's verdict pasted verbatim: `PASS` / `CONCERNS` / `BLOCK`. |
| 5 Provision + Flow Builder impact | Successful `swctl refresh <issue-id>` output (truncated) AND a Flow Builder impact block (events / actions / rules affected, risk level). |
| 6 Test/validate | Output of real test commands (phpunit/phpstan/cs-fix) with exit codes. |
| 7 Prepare PR | `/tmp/pr-body.md` written (or path printed in transcript). |
| 8 Summary | Decision-Ready Output (priority / domain / team / component / effort). |

**Stop criterion:** emit `### STEP 8 END` after the Decision-Ready
Output. Do not add further narrative after that marker.

## Step 1: Verify the issue

**Gate in:** Issue URL, description, or reproduction report.

**Purpose:** Confirm the issue is real, reproducible, and worth investigating.

### 1.1) Reproduce and frame

**Gather issue context first:**
- When the input is a GitHub issue URL or number, fetch full context:
  ```bash
  scripts/read-github-issue.sh <issue-url-or-number>
  ```
- When the input includes log files or error output, auto-extract error signatures:
  ```bash
  scripts/parse-shopware-errors.sh <log-path-or-var/log>
  ```
- Cross-reference extracted signatures with `references/common-signatures.md` to classify the error family (DI, database, plugin lifecycle, messaging, HTTP). Use the top signatures as Priority 1 keywords in Step 1.2.

**Determine the target repo from the issue labels** (this decides where the fix branch lives and where the PR will eventually go):

- Read the labels in the issue payload returned by `read-github-issue.sh`.
- If an `extension/*` label is present, the fix lives in that plugin's own repo, not in `shopware/shopware`. The two you will encounter in practice:
  - `extension/Custom-Products` → `shopware/SwagCustomizedProducts` (checked out at `custom/plugins/SwagCustomizedProducts`)
  - `extension/Commercial` → `shopware/SwagCommercial` (checked out at `custom/plugins/SwagCommercial`)

  For any other `extension/<Name>` you have not seen before, resolve the repo on GitHub (`gh search repos "in:name <Name>" --owner shopware`) before guessing — do not invent a path.
- If no `extension/*` label is present, the fix targets `shopware/shopware` trunk.
- State the resolved target repo explicitly in the Step 1 output template under a `**target repo:**` line so downstream steps (branch creation, test runs, PR body) agree on where the change lands.

**Capture environment and symptom:**
- Capture Shopware version, PHP version, runtime, and deployment mode.
- Capture exact symptom, impact, and first-seen version/time.
- Classify source: core, plugin, app, integration, infra, or search.
- Normalize the verification setup:
  - Shopware version
  - plugin/app set
  - sales-channel/runtime context
  - cache/index state
  - minimal data setup needed to observe the bug
- Prefer the smallest deterministic reproduction path over production-like complexity.
- For storefront/search/product-stream issues, note whether cache clear, DAL indexing, or scheduled tasks are required.

**Reproduction criteria:**
- **Deterministic bug:** One successful reproduction is sufficient. Document the exact steps.
- **Intermittent bug:** Attempt at least 3 runs. If the bug appears in 1+ of 3 runs, mark `REPRODUCED` with a frequency note (e.g., "1/3 attempts"). If 0/3, mark `NOT_REPRODUCED` with the note "intermittent -- could not trigger in 3 attempts."
- **Environment-dependent bug:** If reproduction depends on specific data, config, or infrastructure not available locally, mark `PARTIALLY_REPRODUCED` and document exactly what is missing.

**Domain-specific reproduction tips:**

| Domain | Key considerations |
| --- | --- |
| Checkout/Cart | Test guest + logged-in; check cart rules, promotions, payment/shipping availability |
| Product/Catalog | Check variant visibility, inheritance, sales channel assignment, product stream membership |
| Search | Clear ES/OS indexes (`bin/console es:index`), check `SHOPWARE_ES_ENABLED` and MySQL fallback |
| Admin | Check admin build state, browser console errors, Vue component lifecycle |
| Migration/Schema | Run `bin/console database:migrate --all`, check `migration` table for failures |
| Async/Messaging | Check `messenger:consume` worker status, failed message count, scheduled task health |

### 1.2) Check for duplicates and prior fixes

This issue may already be fixed in a commit you do not know about. Before investing time in root-cause analysis, systematically search for evidence that the problem has been addressed.

**Tool-assisted keyword extraction:**

Before manual extraction, use automated tools if error logs or stack traces are available:
- Run `scripts/parse-shopware-errors.sh` on logs to surface recurring signatures. Use the top signatures as Priority 1 search keywords below.
- Match extracted signatures against `references/common-signatures.md` to identify the error family and narrow the search to the right subsystem.

**Keyword extraction strategy:**

Extract search terms from the issue report in this priority order:

1. **Class/file names** mentioned in the issue or stack trace (e.g., `ProductConfiguratorLoader`, `CartService`). These are the highest-signal keywords because fixes touch the same files.
2. **Method names** from stack traces or error context (e.g., `loadVariants`, `calculatePrice`).
3. **Error messages or exception classes** (e.g., `SQLSTATE[23000]`, `ProductNotFoundException`, `FRAMEWORK__INVALID_CRITERIA`).
4. **Entity/table names** from SQL errors or DAL issues (e.g., `product_option`, `order_line_item`).
5. **Symptom keywords** from the issue title/description (e.g., `configurator sold out`, `variant not visible`, `cart duplicate`).
6. **Affected subsystem** (e.g., `product stream`, `flow builder`, `customer group`, `price calculation`).

**Search sequence (do all three):**

1. **GitHub issues and PRs** - Search for closed issues and merged PRs with similar keywords:
   ```bash
   scripts/search-shopware-sources.sh "<keyword>" shopware/shopware
   ```
   Also try with `shopware/SwagCommercial` if the issue might touch Commercial scope.

2. **Git log in local repo** - Search commit messages for related fixes:
   ```bash
   git log --oneline --all --grep="<keyword>" -- <suspected-file-path>
   git log --oneline --all --grep="<class-name>"
   git log --oneline --all -- <file-path>
   ```
   Check both message content (`--grep`) and file-level history (`-- path`).

3. **Git blame on suspected code** - Check if the relevant code was recently changed:
   ```bash
   git blame -L <start>,<end> -- <file-path>
   ```
   If the code was recently modified, inspect that commit for whether it was a fix for the same symptom.

**Evaluation of search results:**

- If a closed issue or merged PR matches: inspect the fix commit, check which version it shipped in, and verify whether the reporter's version includes that fix.
- If the fix exists but the issue persists: this may be a regression or an incomplete fix. Note the prior fix as evidence and proceed with investigation.
- If no matches found across all three searches: document the keywords tried and proceed.
- Always present search findings to the user before deciding whether to continue.

**Regression-of-prior-fix check:**

If a prior fix is found but the issue persists on a version that should include it, check whether the fix was later reverted or overwritten:
```bash
git log --oneline <fix-commit>..HEAD -- <fixed-file>
git diff <fix-commit>..HEAD -- <fixed-file>
```
If the fixed code changed since the fix commit, this may be a regression. Note the introducing commit.

**When to stop searching:**

- Stop after all three search layers (GitHub, git log, git blame) are complete for at least 2 keyword variants.
- Stop earlier if a clear match is found (closed issue with merged fix targeting the same symptom and code path).
- Stop and escalate to the user if results are ambiguous (multiple partial matches, unclear whether fix applies).
- Do not spend more than one follow-up round beyond the initial three-layer search. If nothing surfaces, document what was tried and proceed.

See `references/source-map.md` for trusted repos and search commands.
See `references/prior-fix-search-guide.md` for advanced git search flags (`-S`, `-G`), evaluation checklist, and common false negative patterns.

### 1.3) Resolve the local repo target

- If the user has a preferred local Shopware repo or worktree, treat that as the default target.
- Default base repo: `/Users/ytran/Shopware/trunk`.

### 1.4) Reproduce in a live worktree

**This is the most important part of Step 1.** Code-level analysis is not enough — you must actually observe the bug in a running Shopware instance before proceeding.

**Create a worktree:**

Spin up a worktree using the issue number. Use `--qa` mode for faster provisioning (copies vendor from trunk instead of running composer install). Each worktree needs a unique branch — create a temporary reproduction branch or use the fix branch directly:
```bash
swctl create --qa <issue-number> repro/<issue-number>
```

**Important:** Only create **2 worktrees at a time**. Creating more simultaneously causes failures. Wait for each batch to complete before starting the next.

Wait for it to be ready:
```bash
swctl status
```

Result:
- Worktree: `/Users/ytran/Shopware/_worktrees/sw-<issue>`
- URL: `http://web.trunk-<issue>.orb.local`
- Container with PHP, Caddy, database, Redis, OpenSearch, and demo data

**Follow the issue's reproduction steps:**

1. **Obtain an Admin API token** for the worktree:
   ```bash
   swctl exec <issue> 'curl -s -X POST http://localhost:8000/api/oauth/token \
     -H "Content-Type: application/json" \
     -d "{\"grant_type\":\"password\",\"client_id\":\"administration\",\"username\":\"admin\",\"password\":\"shopware\"}"'
   ```

2. **Set up test data** matching the issue's preconditions. Use the Admin API via `swctl exec <issue> 'curl ...'` to create products, categories, streams, media, customer groups, or whatever the issue requires. For admin UI reproduction, use Chrome MCP browser tools to interact with `http://web.trunk-<issue>.orb.local/admin`.

3. **Execute the reproduction steps** exactly as described in the issue. For backend issues, use the Admin API or console commands via `swctl exec`. For storefront issues, use the Store API or Chrome MCP. For admin UI issues, use Chrome MCP.

4. **Observe and document the result:**
   - If the symptom appears: capture the evidence (API response, error message, screenshot, DB query result).
   - If the symptom does not appear: try variations, check if the issue was already fixed in trunk, or document what differs from the reporter's environment.

**When live reproduction is not feasible:**

Skip this sub-step only when:
- The bug is purely in static code (e.g., missing JS operator set, wrong Twig condition) and can be verified by reading the source.
- The reproduction requires infrastructure not available locally (e.g., specific payment provider, external API).
- The issue is a migration/schema problem that cannot be triggered with demo data.

In these cases, document why live reproduction was skipped and rely on code-level verification.

**This worktree will be reused** for the fix in Step 2 — do not clean it up.

### 1.5) Determine verification result

- Decide: `REPRODUCED`, `NOT_REPRODUCED`, or `PARTIALLY_REPRODUCED`.
- **Prefer live reproduction evidence** over code-level analysis. A `REPRODUCED` verdict backed by live observation (API output, screenshot, DB query) is stronger than one based only on reading code.

**Gate out:**
- If `REPRODUCED`: present findings and wait for user approval to proceed to Step 2.
- If `NOT_REPRODUCED`: stop. Return a verification result with likely explanations (`already fixed`, `environment-specific`, `missing repro data`). Collaborate with the user on next steps.
- If `PARTIALLY_REPRODUCED`: document what works and what does not. Collaborate with user before proceeding.

**Step 1 output (present to user before gating):**

```md
## Step 1: Verification Result

- **status:** `REPRODUCED` | `NOT_REPRODUCED` | `PARTIALLY_REPRODUCED`
- **confidence:** `deterministic` | `intermittent (N/M attempts)` | `environment-dependent`
- **environment:** Shopware <version>, PHP <version>, <deployment mode>
- **worktree:** `/Users/ytran/Shopware/_worktrees/sw-<issue>` (`http://web.trunk-<issue>.orb.local`)
- **repo target:** <local path>
- **target repo (PR destination):** `shopware/shopware` | `shopware/<PluginRepo>` (derived from issue labels — see Step 1.1)
- **issue labels:** <comma-separated list, especially any `extension/<Name>` label>

### Symptom
<1-2 sentences: what breaks, when, for whom>

### Expected behavior
<1-2 sentences>

### Live reproduction
<evidence from the running worktree: API response, error output, screenshot, or DB query result demonstrating the bug>

### Reproduction steps
1. <step>
2. <step>
3. <step>

### Prior fix search
- **keywords tried:** <list>
- **matches found:** <list with links, or "none">
- **conclusion:** `no prior fix` | `fix exists in <version>` | `possible regression of #<number>` | `partial fix in #<number>`

### Classification
- **source:** `core` | `plugin` | `app` | `integration` | `infra` | `search`
- **error family:** <from common-signatures.md, or "N/A">
- **affected subsystem:** <e.g., checkout, product, admin, search>
```

For `NOT_REPRODUCED` outcomes: replace "Reproduction steps" with "Attempted reproduction" listing what was tried, and add a "likely explanation" field (`already fixed`, `environment-specific`, `insufficient repro data`, `intermittent`).

### 1.6) Exit criteria

All must be true before Step 2:
- symptom described concretely enough to test
- expected behavior is explicit
- environment/version under test is known
- **worktree is running** and available at `http://web.trunk-<issue>.orb.local`
- **live reproduction attempted** (or documented reason why it was skipped)
- local repo/worktree target is known
- likely duplicates, regressions, or prior fixes were checked
- reproduction status is explicit
- Step 1 output template is filled and presented to user
- user has approved proceeding to Step 2

---

## Step 2: Find root cause

**Gate in:** Step 1 exit criteria satisfied AND user approved.

**Purpose:** Identify why the bug happens. Do not start fixing yet.

### 2.1) Build hypotheses

- For simple tickets: one strong root-cause hypothesis is usually enough.
- For complex tickets: provide multiple plausible hypotheses ranked by likelihood.
- For each hypothesis, explain:
  - why it could cause the symptom
  - which code path, subsystem, or data flow it points to
  - what evidence currently supports it
  - what evidence is still missing

### 2.2) Check git history for regressions

- Run `git log -- <target-file>` to identify likely introducing or fixing commits.
- Run `git blame -L <line>,<line> -- <target-file>` on suspicious logic.
- Correlate issue/PR references with current code paths and release notes.
- State explicitly which commit likely introduced the regression, if identifiable.

**Gate out - two paths:**

**Path A: Root cause found with confidence**
- Present the hypothesis to the user for review.
- User confirms -> proceed to create a fix branch and then Step 3.
- Determine branch type from the issue:
  - Bug/regression -> `fix/`
  - Feature/enhancement -> `feat/`
  - Cleanup/tooling -> `chore/`
- **Branch name must include both the issue number AND a descriptive slug** — `<prefix>/<issue-number>-<slug>`. Never create a bare `fix/<issue-number>` or slug-only `fix/<slug>` branch; both forms read poorly in the swctl UI and break the issue link on the dashboard. Good: `fix/10922-reorder-quantity-collision`. Bad: `fix/10922`, `fix/reorder-quantity-collision`. See `references/branch-naming-conventions.md` for the full spec.

- **Reuse the worktree from Step 1.** The worktree at `/Users/ytran/Shopware/_worktrees/sw-<issue>` is already running with trunk and demo data from the reproduction step. Create a fix branch inside it:

  **For core platform fixes:**
  ```bash
  cd /Users/ytran/Shopware/_worktrees/sw-<issue>
  git checkout -b <type>/<number>-<slug>
  ```
  Then make code changes directly in the worktree.

  **For plugin-external projects:** The swctl UI shows diffs by comparing the fix branch against `main`. For the diff to be visible, changes must be committed to the branch **before** the worktree is created. In this case, a separate worktree may be needed:

  1. Create and switch to the fix branch in the plugin repo:
     ```bash
     cd <plugin-repo>
     git checkout -b <type>/<number>-<slug>
     ```
  2. Make code changes and commit (Step 3 implementation).
  3. Switch back to `main` so swctl can check out the branch in the worktree:
     ```bash
     git checkout main
     ```
  4. Clean up the trunk worktree from Step 1 and create a new one with the fix branch:
     ```bash
     swctl clean <issue>
     swctl create --qa <issue> <type>/<number>-<slug>
     ```

  **Examples:**
  ```
  # Core platform fix — reuse existing worktree, create branch inside
  cd /Users/ytran/Shopware/_worktrees/sw-8221
  git checkout -b fix/8221-dynamic-product-groups-cache

  # Plugin fix — need a new worktree with the plugin branch
  swctl clean 5523
  swctl create 5523 fix/5523-custom-product-out-of-stock
  ```

  Result:
  - Worktree: `/Users/ytran/Shopware/_worktrees/sw-<issue>`
  - URL: `http://web.trunk-<issue>.orb.local`
  - Container with PHP, Caddy, database, Redis, OpenSearch

  **Step B — Check status (non-blocking):**
  ```
  swctl_list_instances()
  ```
  Only wait for the worktree when you need to run tests or verify in the browser.

  **Step C — During development, use:**
  - `swctl_exec_command(issueId, command)` — run tests, console commands, composer
  - `swctl_view_diff(issueId)` — inspect changes (works for core fixes; for plugins, use `git diff` in the plugin worktree)
  - `swctl_refresh(issueId)` — pull latest trunk and rebuild delta
  - `swctl_start_stop(issueId, action)` — restart container if needed

  **Step D — Cleanup when done:**
  ```
  swctl_clean(issueId: "<issue>")
  ```

- **Fallback:** If swctl MCP is not available, use `scripts/create-issue-worktree.sh <issue-number> <type> [slug]`.
- See `references/branch-naming-conventions.md` for naming rules.
- See `references/shopware-local-worktree-playbook.md` for swctl integration details and more examples.

**Path B: Root cause unclear or uncertain**
- Present what is known and what is uncertain.
- Collaborate with the user to narrow down: request targeted debugging, more data, or environment access.
- Stay in Step 2 until confidence is sufficient or the user decides to proceed with best-effort hypothesis.

---

## Step 3: Implement the fix

**Gate in:** User confirmed root cause from Step 2. Worktree and branch exist.

**Purpose:** Write the safest minimal fix.

### 3.1) Implementation principles

- Prefer narrow patches, reversible logic, and explicit regression coverage over broad refactors.
- Preserve backward compatibility for extension contracts.
- Keep the main checkout clean; all work happens in the worktree.

### 3.2) Environment setup

When the swctl MCP server is connected, use MCP tools for environment management:
- `swctl_exec_command(issueId, command)` — Run commands in the container (e.g., `bin/console cache:clear`, `composer install`)
- `swctl_refresh(issueId)` — Pull latest changes and rebuild only what changed
- `swctl_start_stop(issueId, action)` — Start/stop/restart the container
- `swctl_list_instances()` — Check instance status and domains

Decide the minimum environment work needed based on changed files (see `references/shopware-admin-storefront-build-rules.md`):

- PHP/DAL/core/service/test-only changes -> no JS build usually needed
- Administration JS/Vue/Twig changes -> admin build needed
- Storefront JS/Twig/asset changes -> storefront build needed
- Migration/schema/indexing changes -> DB reset / reindex needed

Explicitly state:
- admin build needed: yes/no
- storefront build needed: yes/no
- DB reset needed: yes/no
- cache clear needed: yes/no
- DAL reindex needed: yes/no

### 3.3) Required output

Document:
- chosen fix approach and why it is safer than alternatives
- likely break-risk areas
- tests that should protect the change
- environment setup requirements

**Gate out:** Implementation complete. Wait for Step 4 review before proceeding.

---

## Step 4: Independent review

**Gate in:** Step 3 implementation complete.

**Purpose:** Critically evaluate the patch for regressions, missed edge cases, and safer alternatives. The reviewer must produce a written verdict regardless of how the review is performed — a missing Step 4 END marker silently broken every downstream gate.

### 4.1) Run the review

Two execution modes — pick the one your runtime supports. **Both must produce the same artifact format and emit `### STEP 4 END`.**

**Mode A — Sub-agent review (Claude Code only).**
Invoke the Task tool with the prompt in `agents/review-agent.md`. Pass:
1. The `git diff` of Step 3's commits
2. The root cause summary from Step 2
3. The fix rationale from Step 3

The sub-agent runs in a clean context, free from the implementation bias. Its output is the verdict.

**Mode B — Inline self-review (Codex `exec`, or any runtime without a sub-agent tool).**
Codex doesn't have a Task-tool equivalent; recursively spawning `codex exec` inside a running session is unreliable. Instead, perform the review yourself against the criteria below. The framing matters — read this as an instruction, not a soft request:

> "Set aside the implementation. You are now an independent reviewer who has never seen this patch. Evaluate the diff, root cause, and rationale against the checklist below. Do not rubber-stamp — if you can't find concerns, look harder at edge cases, concurrent access, and Shopware-specific contracts. Then write the verdict in the required format."

### 4.2) Review checklist (both modes)

Evaluate against each section. Report specific findings with `file:line` references where applicable.

- **Correctness:** does the fix actually address the root cause? Are null checks, boundaries, and type coercions handled? Are there paths where the symptom could still occur?
- **Backward compatibility:** does the change break any extension contract (public API, event signatures, entity definitions)? Are decorated services / event subscribers / plugin hooks affected?
- **Regression risk:** could this break adjacent code paths? Shared services, traits, base classes? Caching / indexing / state machine transitions?
- **Minimality:** is the change as narrow as possible? Are there unrelated refactors bundled in?
- **Test coverage:** do tests assert the specific broken behavior, not just the happy path? Edge cases (empty data, null, large datasets)?
- **Shopware-specific:** DAL definitions, Flow Builder events/actions/rules, state machines, admin/storefront build needs, migration safety for zero-downtime deployment.

### 4.3) Required artifact

Write the verdict in this exact shape (so downstream gates can grep it):

```md
## Review Verdict: <PASS|CONCERNS|BLOCK>

### Strengths
- <what the implementation does well>

### Concerns
- <specific issue with file:line reference>

### Suggestions
- <improvement or alternative approach>

### Risk Assessment
- regression risk: <low|medium|high>
- backward compatibility: <safe|risk identified: detail>
- test coverage: <adequate|gaps identified: detail>
- flow builder impact: <none|low|medium|high>
```

Verdict semantics:
- **PASS:** correct, minimal, well-tested, safe for extension contracts. Minor style nits don't block.
- **CONCERNS:** likely correct but has identifiable risks, missing coverage, or questionable assumptions. List specific items.
- **BLOCK:** incorrect, regresses, breaks compatibility, or misses the root cause. Per ground rule 4, jump to Step 8 and stop.

**Gate out:** Verdict written, `### STEP 4 END` emitted on its own line. Do NOT skip the marker even if the review is brief — a 5-line "PASS, no concerns identified" with the marker is a complete Step 4; a thorough review without the marker fails the run.

---

## Step 5: Provision environment + Flow Builder impact

**Gate in:** Step 4 review returned `PASS` or `CONCERNS`. If Step 4 returned `BLOCK`, skip directly to Step 8 per ground rule 4.

**Purpose:** Bring up the container so Step 6 can actually run tests, and assess whether the diff affects existing Flow Builder automation flows.

### 5.0) Provision the worktree container

Before running any tests, make sure the swctl container is up and the DB is cloned. On a fresh worktree the container exists but the DB may still be `Missing`.

```bash
swctl refresh <issue-id>
```

Wait until `swctl status <issue-id>` shows `Running` AND the DB column shows `cloned`. Truncate the refresh output (head and tail) when you paste it into the transcript — don't spam logs.

If the refresh fails with a branch-already-checked-out error (the fix branch is checked out in another worktree, e.g. your main trunk), switch that other checkout to a different branch first, then retry.

### 5.1) Why Flow Builder impact matters

Flow Builder is Shopware's automation engine. Flows trigger on business events (order placed, customer registered, payment state changed) and execute actions (send email, change order state, generate documents). Changes to entities, events, state machines, or DAL definitions can silently break active flows.

### 5.2) Run impact analysis

Use `scripts/analyze-flow-impact.sh <worktree-path>` for automated detection, then verify findings manually.

See `references/flow-builder-impact-guide.md` for the full impact decision matrix.

### 5.3) Key areas to check

1. **Events**: Do changed files define, dispatch, or modify any `FlowEventAware` events?
2. **Actions**: Do changes touch any `FlowAction` subclass or its dependencies?
3. **Rules**: Do changes affect `Rule` classes used by flow conditions?
4. **Entity/DAL**: Do entity definition changes affect fields that flow actions read or write?
5. **State machines**: Do state transition changes affect flow triggers?
6. **Caching**: Do changes affect `CachedFlowLoader` or flow payload indexing?

### 5.4) Output format

```md
## Flow Builder Impact
- events affected: <list or "none detected">
- actions affected: <list or "none detected">
- rules affected: <list or "none detected">
- entity/DAL impact: <description or "none detected">
- state machine impact: <description or "none detected">
- risk level: <none|low|medium|high>
- recommended flow validation: <specific flows to test or "standard regression suite">
```

**Gate out:** Impact assessment documented. Proceed to Step 6.

---

## Step 6: Test and validate

**Gate in:** Steps 3-5 complete.

**Purpose:** Verify the fix is correct and does not break existing functionality.

### 6.1) Automated checks

When swctl MCP is available, run checks via `swctl_exec_command(issueId, command)`.
Otherwise run directly in the worktree:
1. `composer phpunit:verify -- <test-path>` for targeted test verification
2. `composer phpstan` for static analysis
3. `composer cs-fix` for code style
4. `composer eslint` if JS/TS files changed
5. `composer stylelint` if SCSS files changed
6. `composer ludtwig:storefront` if storefront Twig files changed

### 6.2) Manual verification

- **Re-run the reproduction steps from Step 1.4** in the same worktree (now with the fix applied). The same test data and API calls that demonstrated the bug should now show the correct behavior. This is the primary proof the fix works.
- Verify the original symptom no longer occurs
- Check the golden path and edge cases
- If flow impact was medium/high: manually verify affected flows
- If admin/storefront changes: smoke test the relevant UI

### 6.3) Output

Document test results: which tests ran, which passed, any failures and how they were addressed.

**Gate out:** All automated checks pass. Manual verification confirms the fix. Proceed to Step 7.

---

## Step 7: Prepare for merge

**Gate in:** Step 6 validation passes.

**Purpose:** Prepare a clean, convention-following commit and PR.

### 7.1) Commit message

Follow the repository convention (see `references/branch-naming-conventions.md`):
```
<type>(<scope>): <message> (#PR_NUMBER)
```

Use `scripts/prepare-pr.sh <worktree-path> <issue-number> --type <fix|feat|chore>` to generate a template.

### 7.2) PR body

Generate the PR body to a file for review:
```bash
scripts/prepare-pr.sh <worktree-path> <issue-number> --type <fix|feat|chore> --output /tmp/pr-body.md
```

The generated body includes:
- summary with `Fixes #<issue-number>` link
- changed files overview
- environment needs (build, DB, cache)
- test plan with checkboxes
- review agent verdict
- flow builder impact level

Present the commit message and PR body to the user for editing before proceeding.

### 7.3) Pre-submission checks

- Branch is up to date with `trunk` (core) or `main` (plugin repo).
- Branch name matches `<prefix>/<issue-number>-<slug>` — see `references/branch-naming-conventions.md`.
- Commits are clean (squash if needed).
- No debug code, temporary files, or unrelated changes.
- No `CHANGELOG.md` edits or new `changelog/_unreleased/*.md` files — ground rule 8. If an earlier commit added one, remove it before handing off.

### 7.4) Create swctl worktree for the fix branch

After committing, create a swctl worktree so the fix is testable from the dashboard. Use `--qa` mode for fast provisioning (copies vendor from trunk, skips frontend builds unless the diff includes JS/SCSS changes).

**For plugin-external projects:**
```bash
swctl create --qa --project <PluginName> --deps <deps> <issue-number> <branch-name>
```

Example:
```bash
swctl create --qa --project SwagCustomizedProducts --deps SwagCommercial 8781 fix/8781-twig-block-name-typos
```

**For core platform fixes:**
```bash
swctl create --qa <issue-number> <branch-name>
```

**Important constraints:**
- Create at most **2 worktrees at a time** — more causes failures.
- The fix branch must NOT be checked out in the main repo when running `swctl create`. Switch back to `main` first (`git checkout main`).
- Verify the worktree is ready: `swctl status` should show `Running`.

**Post-provisioning steps (required for plugin-external projects in QA mode):**

QA mode syncs pre-built assets from trunk but does NOT activate plugins. After the worktree is created, run:

```bash
swctl exec <issue> 'php bin/console plugin:refresh && php bin/console plugin:install --activate <PluginName>'
swctl exec <issue> 'php bin/console bundle:dump && php bin/console assets:install && php bin/console cache:clear'
```

Example for SwagCustomizedProducts:
```bash
swctl exec 8781 'php bin/console plugin:refresh && php bin/console plugin:install --activate SwagCustomizedProducts'
swctl exec 8781 'php bin/console bundle:dump && php bin/console assets:install && php bin/console cache:clear'
```

This ensures:
- The plugin is installed and active in the DB
- `bundle:dump` updates `var/plugins.json` so the admin loads the plugin's JS/CSS bundles
- `assets:install` copies plugin public assets to `public/bundles/`
- Cache is cleared so the DI container picks up the plugin's services

After the worktree is ready, the fix is accessible at `http://web.trunk-<issue>.orb.local` for manual testing and review.

### 7.5) Hand off to the user — do not push, do not open the PR

Per ground rule 6, Step 7 ends at "commit + PR body written to `/tmp/pr-body.md`". The user pushes the branch and opens the PR themselves from the swctl UI / dashboard. You must not:

- run `git push` / `scripts/create-pr.sh` / `gh pr create` for this branch,
- push to any remote,
- suggest "option 2: I push directly" as a shortcut.

If the user explicitly asks you to push anyway, remind them the swctl UI is the intended path and that the skill's rule is to hand off at this step. Only if they then re-confirm after that reminder may you push — and even then, treat it as a one-off that does not change the default for the rest of the session or for future sessions.

Print the branch name, commit SHAs, the path to `/tmp/pr-body.md`, and a one-line prompt like `Open the PR from the swctl dashboard when ready`.

**Gate out:** Branch committed locally, `/tmp/pr-body.md` written, user informed that the swctl UI is the next step. No remote push has happened. Routing labels are NOT applied here — that happens in Step 8.3, only after the user confirms the PR is open.

---

## Step 8: Decision-ready output

**Gate in:** All prior steps complete.

**Purpose:** Produce the final aggregated triage summary.

### 8.1) Deterministic triage template

```md
## Triage result

<one-sentence classification>

## Verification result

- status: `<reproduced|not reproduced|partially reproduced>`
- environment: `<version/runtime/context>`
- repo target: `<local Shopware repo/worktree path>`
- notes: <1-3 lines>

## Issue summary

- shopware version: `<version or unknown>`
- affected area: `<area>`
- symptom: <1 sentence>
- impact: <1 sentence>

## Problem statement

<2-4 sentences describing the broken behavior and why it matters>

## Reproduction

1. <step>
2. <step>
3. <step>

## Root cause

- primary hypothesis: <primary technical finding>
- supporting evidence: <supporting technical finding>
- alternatives: <optional ranked alternative hypotheses>
- confidence: `<high|medium|low>`

## Regression history

- introducing change: <commit link or `not identified`>
- related change: <commit/PR/issue links or `none found`>

## Fix implementation

- chosen approach: <description>
- why safest: <rationale>
- break-risk areas: <list>
- worktree: <path and branch name>
- environment needs: <admin build/storefront build/db reset/reindex/none>

## Review verdict

- verdict: `<PASS|CONCERNS|BLOCK>`
- key findings: <1-3 lines>

## Flow Builder Impact

- events affected: <list or "none detected">
- actions affected: <list or "none detected">
- rules affected: <list or "none detected">
- risk level: <none|low|medium|high>
- recommended flow validation: <description>

## Validation

- tests added/updated: <list>
- automated checks: <pass/fail summary>
- manual verification: <result>
- rollback plan: <1 sentence>

## Routing

- label: `<priority/...>`
- domain: `<domain/...>`
- team: `@shopware/<team-slug>` or `unknown`
- component: `<component/...>` (omit when no defensible component)
- effort: `<easy|medium|hard>`
- evidence: <1-line routing evidence trail>
```

### 8.2) GitHub comment

- Prepare a concise issue-comment version of the triage result.
- If a PR was created in Step 7, include the PR link in the comment body.
- Do not post automatically. Ask the user: `Do you want me to post this triage summary to issue #<number>?`
- After approval, post via `scripts/post-github-issue-comment.sh`.
- Link referenced commits, PRs, and issues to their actual GitHub URLs.

### 8.3) Apply routing labels (only after the PR is open)

Precondition: the user has confirmed the PR has been opened from the swctl UI. Until then, do not ask about labels — the triage isn't actionable yet.

Then ask: `Do you want me to apply routing labels to the issue?`

On approval:
```bash
scripts/manage-issue-labels.sh <issue-url> --add "<priority>,<domain>"
```

Derive labels from the routing section of the triage template:
- `priority/<level>` from severity
- `domain/<area>` from domain classification
- `component/<name>` only when confident

**Never** add, remove, or rename an `extension/*` label — that is maintainer-curated scope (ground rule 7).

---

## Cross-cutting: Reference loading

Load references as needed from any step:

| Reference | When to load |
| --- | --- |
| `references/shopware-platform-map.md` | Broad codebase orientation |
| `references/shopware-local-worktree-playbook.md` | Creating issue worktrees (Step 2) |
| `references/branch-naming-conventions.md` | Branch and commit naming (Steps 2, 7) |
| `references/shopware-dal-guide.md` | DAL, filter, join, aggregation issues |
| `references/shopware-product-stream-guide.md` | Dynamic product groups and streams |
| `references/shopware-admin-storefront-build-rules.md` | Deciding build/reset needs (Step 3) |
| `references/flow-builder-impact-guide.md` | Flow Builder assessment (Step 5) |
| `references/shopware-mcp-dev-integration.md` | MCP-backed Shopware context |
| `references/debug-playbook.md` | Triage and root-cause workflow |
| `references/trunk-debug-commands.md` | Trunk-optimized commands |
| `references/common-signatures.md` | Step 1.1 error classification, Step 1.2 keyword extraction |
| `references/issue-triage-taxonomy.md` | Severity, domain, component assignment |
| `references/prior-fix-search-guide.md` | Step 1.2 prior fix search (advanced git flags, evaluation checklist, false negatives) |
| `references/source-map.md` | Trusted domains and search guidance |
| `references/search-troubleshooting.md` | Elasticsearch/OpenSearch issues |
| `references/prompt-cheat-sheet.md` | Usage examples |

### swctl MCP tools (preferred when connected)

| Tool | Purpose | Used in |
| --- | --- | --- |
| `swctl_smart_create` | Create worktree with pre-flight validation and optimization | Step 2 |
| `swctl_create_worktree` | Create worktree with explicit params (project, deps, mode) | Step 2 |
| `swctl_exec_command` | Run commands in container (tests, console, composer) | Steps 3, 6 |
| `swctl_view_diff` | View git diff for the worktree | Steps 4, 7 |
| `swctl_list_instances` | Check instance status and domains | Steps 3, 6 |
| `swctl_refresh` | Pull latest and rebuild delta | Step 3 |
| `swctl_clean` | Remove worktree, container, and DB | Cleanup |
| `swctl_start_stop` | Start/stop/restart container | Steps 3, 6 |
| `swctl_github_issues` | Fetch assigned GitHub issues | Step 1 |

### Script reference (fallback when swctl MCP is not available)

| Script | Purpose | Used in |
| --- | --- | --- |
| `scripts/read-github-issue.sh` | Fetch issue metadata and comments | Step 1.1 |
| `scripts/search-shopware-sources.sh` | Search GitHub issues, PRs, and code | Step 1.2 |
| `scripts/parse-shopware-errors.sh` | Extract error signatures from logs | Step 1.1, 1.2 |
| `scripts/create-issue-worktree.sh` | Create isolated worktree with branch (fallback) | Step 2 |
| `scripts/analyze-flow-impact.sh` | Detect Flow Builder impact from diff | Step 5 |
| `scripts/prepare-pr.sh` | Generate commit message and PR body | Step 7 |
| `scripts/create-pr.sh` | **Do not invoke.** Pushing/opening PRs is the user's job via the swctl UI — per ground rule 6. | — |
| `scripts/manage-issue-labels.sh` | Add/remove issue labels via `gh` | Steps 7.5, 8.3 |
| `scripts/post-github-issue-comment.sh` | Post comment to GitHub issue | Step 8.2 |
| `scripts/triage-github-issues.sh` | Batch triage issues by severity/effort | Standalone triage |

---

## Guardrails

- Prefer minimal and reversible changes.
- Preserve backward compatibility for extension contracts.
- State assumptions when logs/environment are incomplete.
- Avoid broad refactors while incident scope is unclear.
- For search incidents, account for MySQL fallback behavior and `SHOPWARE_ES_THROW_EXCEPTION`.
- Treat GitHub comments as a publish action: draft first, ask for approval, then post.
- Create PRs as **draft** and assign to the user.
- When running autonomously (batch issues), proceed through all steps without waiting for approval. Stop only if: issue cannot be reproduced, root cause is unclear, or review agent returns BLOCK.

### Worktree creation constraints

- **Max 2 worktrees at a time.** Creating more simultaneously causes failures due to resource contention. Wait for each batch to complete before starting the next.
- **Use `--qa` mode** (`swctl create --qa`) for faster provisioning. QA mode copies vendor from trunk instead of running `composer install`, and skips frontend builds (uses synced assets from trunk), saving significant time.
- **Each worktree needs a unique branch.** Git does not allow the same branch to be checked out in multiple worktrees. Use the fix branch directly (`fix/<issue>-<slug>`) or `repro/<issue>` for reproduction-only worktrees.
- **Detach HEAD in the main repo** before creating a worktree with a branch that is currently checked out: `git checkout --detach HEAD`.

### Smart worktree creation via diff codes

swctl automatically detects what build steps are needed by running `git diff --name-only BASE...BRANCH` and classifying changed files into categories:

| Diff category | File pattern | Build steps triggered |
| --- | --- | --- |
| `MIGRATION_CHANGES` | `Migrations/` | DB reset / reindex |
| `ENTITY_CHANGES` | `Entity/` | DB reset / reindex |
| `ADMIN_CHANGES` | `Resources/app/administration/**/*.{js,ts,vue,scss}` | Admin npm build |
| `STOREFRONT_CHANGES` | `Resources/app/storefront/**/*.{js,ts,vue,scss}`, `*.twig` | Storefront npm build |
| `COMPOSER_CHANGES` | `composer.{json,lock}` | Composer install |
| `PACKAGE_CHANGES` | `package.json`, lock files | npm install |
| `BACKEND_CHANGES` | `*.php` (excluding migrations/entities) | No extra build needed |

**Since Claude Code knows exactly which files were changed in the fix**, the branch diff automatically tells swctl what to build. This means:
- **PHP-only fixes** (most bug fixes): swctl skips all frontend builds → fastest provisioning
- **Admin JS/Vue changes**: swctl runs admin build only
- **Storefront Twig/JS changes**: swctl runs storefront build only
- **Migration/entity changes**: swctl triggers DB reset

**Best practice:** Commit the fix to the branch **before** creating the worktree. This way `git diff` shows the actual changes and swctl can optimize accordingly. In `--qa` mode with PHP-only changes, worktree creation takes ~60-90 seconds.

### Test environment pitfalls

- **Test DB migration drift:** The test database (`shopware_test`) may be missing recent migrations that trunk code expects (e.g., new columns like `og_title`). Before running tests, ensure migrations are current:
  ```bash
  APP_ENV=test bin/console system:install --drop-database --basic-setup --force
  APP_ENV=test bin/console plugin:install <PluginName> --activate
  ```
- **Stream filter accumulation:** When testing product streams via Admin API PATCH, each call **appends** filter conditions instead of replacing them. This corrupts the stream. Either use the Admin UI to edit streams, or delete `product_stream_filter` rows before updating via API.
- **HTTP cache in dev mode:** `APP_ENV=dev` does not enable HTTP cache. To test cache invalidation bugs, switch to `APP_ENV=prod` with `SHOPWARE_HTTP_CACHE_ENABLED=1`. Use `scripts/setup-prod-cache.sh` to toggle this.

## Issue categorization rules

- Do not infer domain or component from the issue's current labels.
- Derive domain in this order:
  1. Mentioned class/file and its `#[Package('...')]` annotation.
  2. Ticket title and description.
  3. Referenced commits, PRs, and issues.
- Use `references/issue-triage-taxonomy.md` for package-to-domain mapping.
- If the issue indicates Commercial scope, inspect `shopware/SwagCommercial` before final assignment.
- After selecting the domain, look up the owning team handle from the taxonomy.
- In GitHub-facing comments, prefer `@shopware/<team-slug>` format.
- Assign component only when a listed component is a close fit with specific evidence.
- Normalize severity to: `security-related`, `critical`, `high`, or `low`.
- Classify effort independently: `easy`, `medium`, or `hard`.
- Include a one-line evidence trail so routing is auditable.

## Example prompts

- "Resolve this Shopware issue: #15934 reset property option selection after delete"
- "Triage these 15 Shopware bug issues and rank by urgency and effort."
- "Checkout throws a 500 after plugin update; find root cause and fix."
- "Admin product save throws SQLSTATE errors after upgrading to 6.7-dev."
- "Search results are wrong after changing analyzers; diagnose and fix."
