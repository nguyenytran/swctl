# swctl Resolve — Architecture & Internals

This document is the deep-dive companion to
[`shopware-resolve-integration.md`](./shopware-resolve-integration.md).
The integration doc tells you *how to use* the resolve feature; this one
explains *how it works end-to-end* — what happens between a click in the
UI and a PR-ready fix in a worktree, with exact file:line references so
you can follow every hand-off in the code.

**Audience:** contributors modifying swctl, integrating skills, or
debugging a resolve run that went sideways.

---

## Table of contents

1. [Architectural overview](#1-architectural-overview)
2. [The three entry points (UI / CLI / desktop)](#2-the-three-entry-points)
3. [Starting a resolve: the UI path in detail](#3-starting-a-resolve-the-ui-path)
4. [Pre-flight: scope detection & branch naming](#4-pre-flight-scope-detection--branch-naming)
5. [Worktree creation (fast path)](#5-worktree-creation-fast-path)
6. [How Claude Code is spawned](#6-how-claude-code-is-spawned)
7. [Skills: what they are and how swctl ships one](#7-skills-what-they-are-and-how-swctl-ships-one)
8. [MCP: giving Claude swctl-specific tools](#8-mcp-giving-claude-swctl-specific-tools)
9. [The 8-step shopware-resolve workflow](#9-the-8-step-shopware-resolve-workflow)
10. [The SSE stream: events the UI receives](#10-the-sse-stream-events-the-ui-receives)
11. [Progress tracking & persistence](#11-progress-tracking--persistence)
12. [Session resume](#12-session-resume)
13. [Multi-issue batch resolve](#13-multi-issue-batch-resolve)
14. [PR creation handoff](#14-pr-creation-handoff)
15. [Caching & invalidation](#15-caching--invalidation)
16. [State locations on disk](#16-state-locations-on-disk)
17. [Troubleshooting recipes](#17-troubleshooting-recipes)

---

## 1. Architectural overview

```
┌────────────── Browser (http://swctl.orb.local) ──────────────┐
│  Resolve page = plugin-rendered UI (not a native Vue route)  │
│  (examples/plugins/shopware-resolve/index.js)                │
└───────────────┬──────────────────────────────────────────────┘
                │ EventSource, fetch
                ▼
┌────────────── swctl-ui container (Node / Hono) ──────────────┐
│  app/server/index.ts        — HTTP + SSE                     │
│  app/server/lib/resolve.ts  — orchestration                  │
│  app/server/lib/cache.ts    — response cache (LRU)           │
│  app/server/lib/events.ts   — in-process event bus           │
└──────┬─────────────────────────────────┬─────────────────────┘
       │ spawn child process             │ spawn child (stdio)
       ▼                                 ▼
┌────────────────────────┐   ┌───────────────────────────────────┐
│  `claude` binary       │   │  swctl MCP server                 │
│  (npm @anthropic-ai/)  │◀─▶│  app/mcp/index.ts (tsx, stdio)    │
│  Loads SKILL.md + MCP  │   │  Exposes swctl_* tools            │
└────────────────────────┘   └───────────────────────────────────┘
       │
       │ executes Steps 1-8, calls built-in + MCP tools
       ▼
┌────────────────────────────────────────────────────────────┐
│  git worktree at ~/Shopware/_worktrees/sw-<id>/            │
│    + optional nested plugin worktree at                    │
│      custom/plugins/<PluginName>/                          │
│  (Step 5 provisions Docker container, DB clone, cache)     │
└────────────────────────────────────────────────────────────┘
```

Three running processes collaborate:

- **swctl-ui server** (Hono + Node, in the `swctl-ui` Docker container).
  Hosts the HTTP API, the plugin-served frontend, and the SSE streams.
- **`claude` binary** (spawned as a child of the server, one process per
  resolve run). Does the actual LLM work, tool execution, and file
  editing in the worktree.
- **swctl MCP server** (spawned by `claude` itself, one process per
  Claude session). Answers JSON-RPC over stdio, exposing swctl-specific
  tools to the model.

All three share the host's `~/.claude/` and `~/.local/state/swctl/` via
bind mounts so the desktop Claude app, the CLI, and the UI operate on
the same state.

---

## 2. The three entry points

swctl deliberately makes the *same* resolve workflow reachable from
three places, producing an identical transcript shape:

| Entry point                | How Claude is spawned                                              |
|----------------------------|--------------------------------------------------------------------|
| Desktop Claude app         | User types `/shopware-resolve <url>` in the app UI                 |
| swctl CLI `resolve`        | `cmd_resolve` in `swctl` runs `claude -p "/shopware-resolve …"`    |
| swctl UI (this doc's focus)| `startResolveStream()` runs the same `claude -p …` in the container|

The invariants that keep them interchangeable:

1. **Same skill** — `~/.claude/skills/shopware-resolve` is a symlink
   into swctl's bundled copy at `skills/shopware-resolve/`, visible to
   both container and host.
2. **Same MCP registration** — `~/.claude/settings.json` has a single
   `mcpServers.swctl` entry that points at `app/mcp/index.ts`.
3. **Same session format** — every session uses a pre-assigned
   `--session-id` UUID, with its transcript at
   `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`.
4. **Same step-marker contract** — SKILL.md requires `### STEP N START`
   / `### STEP N END` lines, parsed identically by all three callers.

Consequence: a run started in the UI can be resumed from the terminal
with `claude --resume <id>`, and vice versa.

---

## 3. Starting a resolve: the UI path

### 3.1 Click → HTTP

The `/#/resolve` page is rendered by a plugin, not a native Vue route
(see `app/src/router.ts` — no `/resolve` entry). The plugin at
`examples/plugins/shopware-resolve/index.js:1514` registers itself:

```js
{ path: '/resolve', render: renderResolvePage }
```

When the user submits an issue URL or checks rows from the GitHub
picker and clicks "Resolve N issues", the plugin opens a server-sent
events connection:

```js
const url = `/api/skill/resolve/stream?issue=${encodeURIComponent(issue)}`
const es  = new EventSource(url)
```

### 3.2 HTTP → handler

Route: `app/server/index.ts:1193`

```ts
app.get('/api/skill/resolve/stream', (c) => {
  const issue = c.req.query('issue') || ''
  const project = c.req.query('project') || undefined
  const mode = (c.req.query('mode') as 'qa' | 'dev') || 'qa'
  if (!issue) return c.json({ error: 'Missing issue' }, 400)
  cancelStream(`resolve:${issue}`)    // preempt any prior in-flight run
  return startResolveStream(c, { issue, project, mode })
})
```

The key move here is `cancelStream(…)`: if you click Resolve twice on
the same issue, the first run is killed before the second starts.

### 3.3 Handler → SSE

`startResolveStream()` lives at `app/server/lib/resolve.ts:335`. It
returns from `streamSSE(c, async (stream) => …)`, which holds the HTTP
connection open and writes `text/event-stream` chunks for every `log`
line the child process produces.

From here on, the server is a dumb pipe: Claude writes to stdout, we
parse lightly and forward to the browser.

---

## 4. Pre-flight: scope detection & branch naming

Before spawning Claude, the server does cheap prep. Every decision is
mirrored as a `log` SSE event so the user can see why the run went the
way it did.

### 4.1 Extract issue id

```ts
const issueMatch = issue.match(/\/issues\/(\d+)/) || issue.match(/^(\d+)$/)
const issueId = issueMatch ? issueMatch[1] : issue.replace(/\D/g, '')
```

Accepts: full URL, `#14395`, `14395`, or even a branch name
containing digits.

### 4.2 Stale-instance guard

If an instance for this issue already exists but its scope (platform
vs a specific plugin) mismatches what the issue's labels say, **abort**
rather than reusing a stale instance:

```ts
if (existing && !project) {
  const labels = await fetchIssueLabels(issue)
  const detected = detectPluginScopeFromLabels(labels)
  const actualPlugin = (existing as any).pluginName || ''
  if (detected && detected !== actualPlugin) {
    // log: "run 'swctl clean <id>' and retry"
    return sendEvent('done', { exitCode: 1, elapsed: 0 })
  }
}
```

This is the difference between a good resolve run and an hour-long
one where Claude wrote plugin code inside a platform-only worktree.

### 4.3 Fetch labels once, reuse

`fetchIssueLabels(issueRef)` hits the GitHub REST API using swctl's
token (`~/.local/state/swctl/github.token`). The result is reused for:

- **Scope detection** (`detectPluginScopeFromLabels`, `resolve.ts:184`) —
  matches `extension/<Name>` labels against registered plugin projects,
  falling back to `platform` if nothing matches.
- **Branch prefix** (`branchPrefixFromLabels`, `resolve.ts:161`):

  | Labels contain…       | Prefix |
  |-----------------------|--------|
  | `bug` / `regression`  | `fix`  |
  | `feature`             | `feat` |
  | `chore` / `docs`      | `chore`|
  | anything else         | `fix`  |

Result: a branch name like `fix/14395` and an `effectiveProject`.

---

## 5. Worktree creation (fast path)

```bash
swctl create --qa --no-provision [--project <plugin>] 14395 fix/14395
```

Why each flag:

- `--qa` — copies `vendor/` from the trunk worktree instead of running
  `composer install`. Shaves ~3 minutes off first-time setup.
- `--no-provision` — **defers** the heavy work. In "fast path" mode we
  only create the git worktree (~5 s). No Docker container, no DB
  clone, no Shopware install. Those happen later when Claude reaches
  Step 5.
- `--project` — passed only for plugin-external projects (where the
  fix commit lives in the nested plugin repo). Omitted for platform.

On success: emit `instance-changed` → cache middleware drops the
`instances` tag → every open browser gets a fresh list on next paint.

On failure: the handler emits the last 10 lines of swctl output as
`log` events and sends a `done` with `exitCode: 1`. Launching Claude
against a half-created worktree only produces a confusing "exit 0 with
nothing done" run, so we never do that.

---

## 6. How Claude Code is spawned

### 6.1 The command

```bash
claude -p "/shopware-resolve <issue-url>\n\n(issue id for Step 5 swctl refresh: 14395)" \
  --output-format stream-json \
  --verbose \
  --permission-mode acceptEdits \
  --allowedTools "Bash Edit Write Read Grep Glob Task WebFetch WebSearch TodoWrite" \
  --session-id <pre-assigned-uuid> \
  --effort max \
  --add-dir /Users/ytran/Shopware/_worktrees/sw-14395
```

### 6.2 Why each flag is non-negotiable

Every flag here was a debugging lesson. Removing any one of them breaks
non-interactive runs.

| Flag | Reason |
|---|---|
| `-p` | Non-interactive print+exit mode. Required for headless server use. |
| `--output-format stream-json --verbose` | Emit one JSON line per turn → swctl parses for step markers + cost. `--verbose` is required together with `stream-json` in `-p` mode. |
| `--permission-mode acceptEdits` | Auto-approve file edits. `bypassPermissions` is rejected when Claude runs as root (the container's node process is root). |
| `--allowedTools "…"` | Every built-in tool the skill uses must be pre-approved. Without this, a non-interactive run blocks forever on the first `Bash(…)` request. |
| `--session-id <uuid>` | Pre-assigned so `claude --resume <uuid>` works even if Claude never got far enough to pick one itself. |
| `--effort max` | Widest thinking budget per turn. The 8-step skill benefits from room. |
| `--add-dir <path>` | Scopes Claude to the worktree. Prevents accidental writes outside. |

### 6.3 Where the binary comes from

The `swctl-ui` container installs a Linux-native binary:

```dockerfile
RUN npm install -g @anthropic-ai/claude-code
```

At runtime, `HOME` in the container is set to the host user's home
(`$HOME`), and the entire home directory is bind-mounted. So:

- The container's `claude` reads `~/.claude/.credentials.json` that
  was written by your desktop app's `/login` — **one login covers
  both**.
- Transcripts written to `~/.claude/projects/…/<session>.jsonl` are
  written through to your host disk and visible from `claude --resume`
  on the terminal.
- Skills in `~/.claude/skills/` are shared.
- `~/.claude/settings.json` — same mcpServers block for both apps.

---

## 7. Skills: what they are and how swctl ships one

### 7.1 Anatomy of a skill

A skill is a directory under `~/.claude/skills/<name>/` containing at
minimum a `SKILL.md` with YAML front-matter:

```markdown
---
name: shopware-resolve
description: >-
  Shopware 6 issue resolution workflow: triage, root-cause analysis,
  fix implementation, independent review, Flow Builder impact
  assessment, validation, and PR preparation.
---

# Shopware Resolve
Structured 8-step workflow ...
```

Claude Code scans `~/.claude/skills/` at session start, reads every
`SKILL.md`, and makes the skill invokable as a slash command
(`/<name> …`) or triggerable by description match.

Our skill ships additional assets alongside SKILL.md:

```
skills/shopware-resolve/
├── SKILL.md                 # the workflow + ground rules
├── README.md
├── agents/                  # sub-agent prompts (Step 4 review)
├── references/              # domain knowledge Claude can Read()
│   ├── branch-naming-conventions.md
│   ├── common-signatures.md
│   ├── shopware-dal-guide.md
│   └── …
├── scripts/                 # small bash helpers Claude invokes
│   ├── read-github-issue.sh
│   ├── parse-shopware-errors.sh
│   ├── search-shopware-sources.sh
│   └── …
└── validate-all-skills.sh
```

Claude invokes the scripts via `Bash(…)` and reads the reference docs
via `Read(…)` when the workflow says so.

### 7.2 How the skill lands in `~/.claude/skills/`

Shipping path, from repo to container:

1. **Repo**: the skill lives at
   `/Users/ytran/Shopware/swctl/skills/shopware-resolve/` (canonical
   copy in this repo, edited directly).
2. **Homebrew**: `Formula/swctl.rb` does
   ```ruby
   pkgshare.install ".swctl.conf.example", …, "skills", …
   ```
   so every brew install places it at
   `$(brew --prefix)/share/swctl/skills/shopware-resolve/`.
3. **Container entrypoint**: `app/docker-entrypoint.sh` runs on every
   container boot. It creates a symlink (idempotent + respectful):
   ```bash
   ln -sfn /swctl/skills/shopware-resolve ~/.claude/skills/shopware-resolve
   ```
   - If the symlink already exists and points somewhere valid (often a
     user's dev checkout), it is **left alone** — we never clobber.
   - If it exists but dangles (target missing), it's repointed to the
     bundled skill.
   - If a regular directory exists (user installed manually), skip.
4. **Bind mount**: because `~/.claude/` is bind-mounted from the host,
   the symlink is visible to *both* the container's Claude and the
   desktop Claude app.

### 7.3 How `/shopware-resolve` invocation works

When Claude sees `/shopware-resolve <issue>` in the user prompt:

1. Matches `shopware-resolve` in its skill registry.
2. Expands SKILL.md's body into the system context for this session.
3. Treats everything after `/shopware-resolve` as arguments to the
   skill's instructions.
4. Proceeds turn-by-turn through the 8 steps, using every tool it has
   — built-in + MCP.

### 7.4 The step-marker contract

The top of SKILL.md has a "Ground rules" section that every step must
honor. The most important rule:

> **Emit step markers on their own line.** Start each step with
> `### STEP <N> START: <name>` and end it with `### STEP <N> END` once
> the step's required artifact exists.

This is what lets swctl track progress without guessing at Claude's
internal state. Server-side, `observeStreamLine()` in `resolve.ts`
parses `### STEP (\d+) END` out of the stream-json lines and updates
`streamState.lastCompletedStep`, which later writes to the instance
env file and fires in the final SSE `done` event.

The rules live in SKILL.md itself (not in the prompt we build) so the
CLI, UI, and desktop all produce identical transcripts.

### 7.5 The "required artifact per step" table

SKILL.md enforces that each step output includes a specific artifact:

| Step | Required artifact |
|---|---|
| 1 Verify | Reproduction commands + error signature |
| 2 Root cause | Hypothesis paragraph + affected files |
| 3 Implement | `git diff` output of the edit |
| 4 Review | Review verdict + issues raised by sub-agent |
| 5 Flow Builder impact | Flow catalog check + affected events list |
| 6 Validate | Test command outputs (`bin/phpunit`, storefront screenshot) |
| 7 PR body | `/tmp/pr-body.md` content printed inline |
| 8 Wrap-up | Summary + next-action list |

"I would do X" is not enough — Claude must execute and show output.

---

## 8. MCP: giving Claude swctl-specific tools

### 8.1 What MCP is

**Model Context Protocol**: a JSON-RPC protocol over stdio that lets
Claude discover and call tools exposed by a separate process. Think
"plugins for Claude Code". Each MCP server can expose:

- **Tools** — model-callable actions (`swctl_create_worktree`, …)
- **Resources** — model-readable data (`swctl://instances/14395`, …)
- **Prompts** — optional preset prompts (swctl doesn't use these)

### 8.2 How Claude finds swctl's MCP server

Via `~/.claude/settings.json` (written by
`app/docker-entrypoint.sh` on first container boot, then left alone):

```json
{
  "mcpServers": {
    "swctl": {
      "command": "npx",
      "args": ["tsx", "/app/mcp/index.ts"],
      "env": { "SWCTL_UI_URL": "http://swctl.orb.local" }
    }
  }
}
```

When Claude starts any session, it:

1. Reads `settings.json`, finds `mcpServers.swctl`.
2. Spawns `npx tsx /app/mcp/index.ts` as a child process with
   `stdio: 'pipe'`.
3. Speaks JSON-RPC over the child's stdin/stdout.
4. Calls `tools/list` → receives the swctl tool schemas.
5. Presents those tools alongside built-ins in the model's tool menu.

The MCP server's lifecycle is tied to the Claude session — exits when
Claude exits. No daemon to manage.

### 8.3 Tool inventory

From `app/mcp/index.ts`:

| Tool                    | Use in the skill                                 |
|-------------------------|--------------------------------------------------|
| `swctl_list_instances`  | Step 1 — sanity-check existing state             |
| `swctl_github_issues`   | Step 1 — read related issues via dedicated tool  |
| `swctl_smart_create`    | (rarely — we pre-create in UI before Claude spawns) |
| `swctl_create_worktree` | (same)                                           |
| `swctl_view_diff`       | Step 3 — inspect the edit before review          |
| `swctl_exec_command`    | Step 6 — run `bin/phpunit`, `composer` inside container |
| `swctl_start_stop`      | Step 5 — restart container if a config change requires it |
| `swctl_refresh`         | Step 5 — pull trunk + rebuild admin/storefront   |
| `swctl_setup`           | Step 5 — provision the deferred container for the first time |
| `swctl_clean`           | — (never called during a resolve, only manually) |

### 8.4 Example: a tool call end-to-end

At Step 5, SKILL.md says "call `swctl_refresh` with the issue id".
Claude emits a tool_use block:

```json
{ "name": "swctl_refresh", "input": { "issueId": "14395" } }
```

The MCP server's `CallToolRequestSchema` handler in `app/mcp/index.ts`
routes it to `refresh(issueId)` in `app/mcp/tools.ts`. That function
shells out to the real `swctl` binary (via the `SWCTL_PATH` env var,
set to `/swctl/swctl` in the container compose file):

```ts
const result = await execFile(process.env.SWCTL_PATH!, ['refresh', issueId])
```

Returns MCP-formatted content:

```json
{ "content": [{ "type": "text", "text": "Rebuilt admin + storefront in 12.4s\n…" }] }
```

Claude reads the content and continues the turn.

### 8.5 Why MCP instead of `Bash(swctl …)`

Claude *could* just run `Bash("swctl refresh 14395")` — but MCP gives:

1. **Structured I/O**. Tool args are typed against a JSON schema, so
   Claude can't "forget --project" or get shell escaping wrong.
2. **No shell-quoting tax**. Especially for tools with file paths
   containing spaces or `"`.
3. **Security surface**. MCP tools run with whatever the MCP process
   can do; the model can't bypass the schema to run arbitrary shell.
4. **Discoverability**. The tool appears in Claude's tool list
   automatically — the skill doesn't have to teach it shell syntax.
5. **Composability**. Tool responses include structured `content`
   blocks Claude can reason about without having to parse stdout.

### 8.6 Resources

MCP resources give Claude a URI-based read interface. swctl exposes:

| URI                            | Returns                      |
|--------------------------------|------------------------------|
| `swctl://config`               | `.swctl.conf` contents       |
| `swctl://projects`             | Registered project list      |
| `swctl://instances/<issueId>`  | Full instance env file       |

Handler: `ReadResourceRequestSchema` in `app/mcp/index.ts`, backed by
`app/mcp/resources.ts`. These are read only when Claude's `Read(…)`
tool can't cover the need — e.g. reading an instance's full env
(branch, db name, composer state, etc.) as one call.

---

## 9. The 8-step shopware-resolve workflow

Full detail in `skills/shopware-resolve/SKILL.md`. Summary:

### Step 1: Verify
- Fetch issue via `scripts/read-github-issue.sh` or `swctl_github_issues`.
- Parse error signatures from the reported logs (`scripts/parse-shopware-errors.sh`).
- Cross-reference `references/common-signatures.md` to classify the error family (DI, DAL, HTTP, Messaging…).
- Search `shopware/shopware` + `SwagCommercial` for prior fixes
  (`scripts/search-shopware-sources.sh`).
- Verdict: `REPRODUCED` / `NOT_REPRODUCED` / `PARTIALLY_REPRODUCED`.

### Step 2: Root cause
- Enumerate hypotheses ranked by likelihood.
- Use `git log` + `git blame` on suspected files to find the introducing commit.
- Confirm with the user (interactive) or pick the top hypothesis (non-interactive).

### Step 3: Implement fix
- Apply the minimal, reversible patch in the worktree.
- Preserve extension contracts (DAL fields, events, controller signatures).
- Keep the change in one conceptual unit.

### Step 4: Independent review
- Spawn a sub-agent using the prompt at
  `skills/shopware-resolve/agents/review-agent.md`.
- The sub-agent receives the diff + Step 2 summary + Step 3 rationale.
- Verdict: `PASS` / `CONCERNS` / `BLOCK`. Blocking concerns abort Step 5.

### Step 5: Flow Builder impact + provisioning
- Scan the diff for events/actions/rules that Flow Builder subscribes to.
- If the fix has no Flow Builder impact and review passed: call
  `swctl_refresh` (or `swctl_setup` on first run) to build/bring up the
  Docker container. This is where the 1-2 min heavy provisioning lives
  — deferred from Step 0 so it only runs when the fix is going to be tested.

### Step 6: Validate
- Run unit tests: `bin/phpunit --filter … | swctl_exec_command`.
- Run integration tests relevant to the fix.
- For admin/storefront changes: manual check via the browser against
  `http://web.trunk-<id>.orb.local`.

### Step 7: Prepare PR body
- Write `/tmp/pr-body.md` in the canonical Shopware PR format
  (Summary / Fixes / Root cause / Reproduction / Test plan / Flow
  Builder Impact). See `references/prompt-cheat-sheet.md`.
- This is what the Create PR modal picks up later (see §14).

### Step 8: Wrap-up
- Print a decision-ready summary: what changed, what's left, what the
  reviewer should focus on.
- Stop. Do **not** push. Do **not** run `gh pr create`. The user
  drives PR creation through the UI modal where they can edit the
  title/body/base branch.

---

## 10. The SSE stream: events the UI receives

Every resolve run emits a stream of SSE events the plugin consumes:

```
event: log        data: {"line":"[swctl] Creating worktree for #14395...","ts":1776568123000}
event: log        data: {"line":"[scope] issue labels: domain/inventory, priority/high","ts":…}
event: log        data: {"line":"[scope] no extension/* label matched → platform scope","ts":…}
event: log        data: {"line":"[branch] prefix from labels → fix/","ts":…}
event: log        data: {"line":"[swctl] swctl create --qa --no-provision 14395 fix/14395","ts":…}
event: log        data: {"line":"[swctl] Worktree ready.","ts":…}
event: log        data: {"line":"[claude] Starting /shopware-resolve https://github.com/…","ts":…}
event: log        data: {"line":"{\"type\":\"system\",...}","ts":…}     ← Claude JSON lines
event: log        data: {"line":"{\"type\":\"assistant\",...}","ts":…}
event: log        data: {"line":"### STEP 1 START: Verify","ts":…}
event: log        data: {"line":"...","ts":…}
event: log        data: {"line":"### STEP 1 END","ts":…}
...
event: done       data: {"exitCode":0,"elapsed":384291,"sessionId":"abc-…","lastCompletedStep":8}
```

The plugin:
- Appends every `log.line` to the rolling log panel.
- Runs `renderLine()` to colorize `[swctl]`, `[scope]`, `[claude]` prefixes.
- Watches for `### STEP N START/END` to light up the stepper.
- On `done`, clears the stepper's active state, enables Create-PR
  buttons, and triggers a `paintTable()` refresh.

On network error / tab close: `stream.onAbort` fires server-side →
`child.kill()` stops Claude → the MCP child exits with it. Nothing
leaks.

---

## 11. Progress tracking & persistence

Two things store progress outside Claude's head:

### 11.1 The instance env file

`~/.local/state/swctl/instances/<issueId>.env` holds:

```bash
ISSUE_ID=14395
BRANCH=fix/14395
PROJECT=trunk                        # or e.g. SwagCustomizedProducts
PROJECT_TYPE=platform                # or plugin-external
WORKTREE_PATH=/Users/.../sw-14395
COMPOSE_PROJECT=trunk-14395
DB_NAME=shopware_14395
DB_STATE=cloned
STATUS=complete
CLAUDE_SESSION_ID=c3d4e5f6-…         # the pre-assigned UUID
CLAUDE_RESOLVE_STATUS=done           # running | done | failed
CLAUDE_RESOLVE_STEP=8                # 0..8
CLAUDE_RESOLVE_COST=1.23             # $ of Anthropic usage
CLAUDE_RESOLVE_STARTED=2026-04-18T16:45:00Z
```

`patchResolveMetadata()` in `resolve.ts` writes this file atomically
(temp file + rename) whenever step progress changes. It's the source
of truth the UI uses to colorize rows and the CLI uses to find a
session id for `swctl resolve resume`.

### 11.2 The run ledger

`~/.local/state/swctl/resolve-runs.json` is a simple JSON array of
`{ issue, project, mode, startedAt, finishedAt, status, exitCode }`.
Used by the resolve page's "recent runs" sidebar and listable via
`GET /api/skill/resolve/runs`.

### 11.3 Claude's native transcript

Separate from swctl: `claude` itself writes each session to
`~/.claude/projects/<cwd-slug>/<session-id>.jsonl`. Every message,
every tool call, every tool result, one line each. This is the
"ground truth" record — swctl doesn't duplicate it.

---

## 12. Session resume

When a resolve run fails or you want to continue:

1. UI: Resume button → `GET /api/skill/resolve/resume/stream?issueId=14395`
2. Handler: `startResolveResumeStream()` at `resolve.ts:562`
3. Reads `CLAUDE_SESSION_ID` from the env file.
4. Spawns `claude --resume <id> -p "<continuation prompt>"` — same
   skill, same transcript, picks up from the step after
   `CLAUDE_RESOLVE_STEP`.

Because transcripts live in `~/.claude/projects/`, you can also resume
from the terminal:

```bash
claude --resume $(jq -r .CLAUDE_SESSION_ID ~/.local/state/swctl/instances/14395.env)
```

…and the UI will still pick up the updated progress via its next
table refresh (the cache middleware invalidates on `instance-changed`,
which the CLI also emits).

---

## 13. Multi-issue batch resolve

When the GitHub picker has N checkboxes selected and you click
"Resolve N issues":

1. Plugin iterates **serially**, not in parallel:
   ```js
   for (const url of selected) {
     await runResolveStream(url)   // wait for `done` before starting next
   }
   ```
2. Rationale: `swctl create` is capped at 2 simultaneous worktrees in
   the implementation (higher concurrency breaks the docker-compose +
   network allocation logic).
3. Each issue gets its own worktree, its own branch, its own session
   id, its own row in the resolve table.
4. A single "Stop" button aborts the whole queue (`AbortController`
   passed into each iteration).

---

## 14. PR creation handoff

The resolve skill **stops before pushing anything**. PR creation is
always user-initiated.

### 14.1 The handoff artifact

Step 7 writes `/tmp/pr-body.md` in the Shopware #16215 format:

```markdown
## Summary
- <bullets>

Fixes shopware/shopware#14395

## Root cause
<paragraph>

## Reproduction
1. <step>

## Test plan
- [ ] <check>

## Flow Builder Impact
None — <justification>
```

### 14.2 The Create PR modal

When the user clicks "Create Draft PR" on the resolve table:

1. `GET /api/skill/resolve/pr/preview-create?issueId=14395` → returns
   the computed `title`, `body`, `baseBranch`, `linkRef`,
   `commitCount`.
2. The `body` field is chosen with this precedence:
   1. `/tmp/pr-body.md` if present and contains the expected `Fixes …`
      link (Step 7's output).
   2. Otherwise, `generatePrBody()` spawns `claude -p` with
      `--allowedTools ""` to produce the same format on-the-fly.
   3. Otherwise, the minimal fallback: `Fixes <linkRef>\n\nCreated by
      swctl resolve`.
3. The modal shows the computed values as editable fields — user can
   tweak title, body, base branch before submitting.
4. `POST /api/skill/resolve/pr/create` with `{ issueId, title?, body?,
   baseBranch? }` triggers the actual:
   - `git reset --soft <merge-base> && git commit --amend -m <title>`
     (squash)
   - `git push --force-with-lease`
   - `gh pr create --body-file /tmp/pr-body-<id>-<ts>.md --assignee @me --draft`

### 14.3 Why `--body-file` not `--body`

Markdown bodies contain backticks, newlines, `$`, `"` — all of which
the shell or `gh`'s argument parser can mangle. Using `--body-file`
takes the string verbatim off disk. The temp file is cleaned up after
the call succeeds.

---

## 15. Caching & invalidation

Every GET endpoint the resolve page hits on each repaint is cached
(`app/server/lib/cache.ts`):

| Route                                 | TTL   | Tag       | Invalidates on |
|---------------------------------------|-------|-----------|----------------|
| `/api/instances`                      | 5 s   | `instances` | `instance-changed` |
| `/api/github/issues`                  | 60 s  | `github`    | manual flush |
| `/api/github/labels/defaults`         | 5 min | `labels`    | — |
| `/api/plugins/list`                   | 60 s  | `plugins`   | — |
| `/api/skill/resolve/pr`               | 10 s  | `pr`        | `instance-changed` |
| `/api/skill/resolve/pr/batch`         | 15 s  | `pr`        | `instance-changed` |

Backed by `lru-cache` (`max: 500`, native TTL, LRU eviction). Sends
`X-Cache: HIT` / `MISS` headers for debugging.

Event → tag wiring in `installCacheInvalidators()`:

```ts
subscribe((event) => {
  if (event.type === 'instance-changed') {
    invalidateTag('instances')
    invalidateTag('pr')         // PR state often changes with instance changes
  }
})
```

`instance-changed` fires from:
- Worktree create/refresh/clean.
- Resolve run finish (success or fail).
- `prAction()` success (push/create/merge/approve/ready).

So after any user action that could have moved state, the next paint
sees fresh data automatically.

---

## 16. State locations on disk

| Path | Written by | Holds |
|---|---|---|
| `~/Shopware/_worktrees/sw-<id>/` | `swctl create` | Git worktree (platform) |
| `~/Shopware/_worktrees/sw-<id>/custom/plugins/<Name>/` | `swctl create` (plugin-external) | Nested plugin worktree (where the fix commit lives) |
| `~/.local/state/swctl/instances/<id>.env` | `resolve.ts:patchResolveMetadata` | Branch, session id, step, status, cost |
| `~/.local/state/swctl/resolve-runs.json` | `recordStart` / `finishResolveRun` | Run ledger |
| `~/.local/state/swctl/github.token` | `swctl auth login` / UI OAuth | swctl's GitHub token |
| `~/.local/state/swctl/checkout.state` | `swctl checkout` | Currently checked-out instance |
| `~/.claude/.credentials.json` | `claude /login` | OAuth creds shared with desktop app |
| `~/.claude/settings.json` | `app/docker-entrypoint.sh` (first boot only) | `mcpServers.swctl` registration |
| `~/.claude/skills/shopware-resolve` | `app/docker-entrypoint.sh` (symlink) | → `/swctl/skills/shopware-resolve` |
| `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` | `claude` | Full transcript of each session |
| `/tmp/pr-body.md` | Step 7 of skill | PR body draft |
| `/tmp/pr-body-<id>-<ts>.md` | `prAction('create')` | Final body passed to `gh --body-file` |

---

## 17. Troubleshooting recipes

### "Not logged in — please run /login"

Claude in the container doesn't have a Linux-compatible session.
`~/.claude/.credentials.json` may have been written by the macOS
Keychain. Fix:

```bash
docker exec -it swctl-ui claude /login
```

Do the auth flow once. The resulting creds write to
`~/.claude/.credentials.json` (Linux-compatible) and are then visible
to both the container and the desktop app.

### "No worktree" / "branch doesn't exist"

The `--no-provision` worktree might have been cleaned up. Re-create it:

```bash
swctl clean 14395
swctl create --qa --no-provision 14395 fix/14395
```

…or start a fresh resolve from the UI — it handles the create for you.

### Run says "### STEP 5 START" and then stops with `exitCode: 0`

Claude quietly gave up, typically because a tool it needed wasn't in
`--allowedTools`. Check the last 50 lines of the transcript:

```bash
tail -50 ~/.claude/projects/-Users-ytran-Shopware--worktrees-sw-14395/<session-id>.jsonl
```

Look for a `"type":"assistant"` message with `"stop_reason":"tool_use"`
whose tool name isn't in our allowlist.

### Resume button greyed out

Means the instance env file has `CLAUDE_SESSION_ID=""`. Either the run
never actually spawned Claude (failed in Step 1 pre-flight), or the
env file was manually edited. You can seed it:

```bash
echo 'CLAUDE_SESSION_ID=<some-uuid>' >> ~/.local/state/swctl/instances/14395.env
```

…and try resume, but you probably want to just `swctl clean 14395`
and start fresh.

### MCP tool calls fail with "connection closed"

The MCP process crashed mid-session. Check its stderr:

```bash
docker logs swctl-ui 2>&1 | grep -A2 '\[mcp\]'
```

Common causes: `SWCTL_PATH` not set (container env mismatch), or the
mounted `/Users/ytran/.local/state/swctl` is unavailable. Restart the
container:

```bash
swctl ui stop && swctl ui start
```

### PR body modal stuck on "Loading preview…"

`generatePrBody()` spawns `claude -p` with a 2-minute timeout. If
Claude isn't authenticated or the network is slow, it never returns.
Workaround: close the modal, the minimal fallback body will be used
on a retry. For a proper fix, drop a canonical body at
`/tmp/pr-body.md` and re-open — the modal uses that verbatim.

---

## Cross-references

- [`shopware-resolve-integration.md`](./shopware-resolve-integration.md) — user-facing setup guide.
- [`plugins.md`](./plugins.md) — how swctl UI plugins work (the
  resolve page is one).
- [`resolve-setup.md`](./resolve-setup.md) — prerequisites checklist.
- `skills/shopware-resolve/SKILL.md` — the skill itself (ground rules,
  step-by-step instructions, artifact contracts).
- `app/server/lib/resolve.ts` — server-side orchestration.
- `app/mcp/index.ts` + `app/mcp/tools.ts` — the MCP server.
- `examples/plugins/shopware-resolve/index.js` — the UI plugin.
