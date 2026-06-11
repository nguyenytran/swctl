# Repro feature — design

Branch: `feat/repro-scenarios`.  Reproduce a Shopware issue from report
to verified-or-not, AI-first, with the reproduction artifact (assertion
result or screenshot) captured for the PR.

## Why

Today reproducing an issue means: read it, figure out what instance you
need, create it, hand-seed data, click through, judge if the bug is
real.  Minutes-to-hours of setup per issue, much of it repeated.  The
repro flow front-loads the AI on the *reading + planning*, then
automates the *create → seed → run → verdict*, and hands a human a live
instance only when the bug actually reproduces.

## Flow (one click: "Reproduce")

```
ANALYZE (done)            create the plan, no instance yet
  issue + focus tags → AI one-shot → brief:
    category, feasibility, instanceNeeds{enableEs, project},
    setup[], execute[], checks[], scenarioYaml | playwrightSpec
  (streamed: phase logs + progress bar)
        │
        ▼
VERIFY (automated)
  1. create instance      swctl create + brief flags (--enable-es,
     (Shopware workflow)     --project); REUSE the issue's instance if
                            one exists.  Reset to a clean DB first so
                            seeded data is the only data (deterministic).
  2. seed test data        scenario setup: phase (Admin API / console)
  3. execute               headless → curl request / console
                           browser  → Playwright spec drives the UI
  4. verdict               headless → assert status/json/body
                           browser  → assertions + screenshot at the point
                           → REPRODUCED | NOT_REPRODUCED
        │
        ▼
HAND-OFF (human)
  REPRODUCED      keep the SAME instance running, left in the reproduced
                  state; show URL + screenshot + trace.  Human opens the
                  URL and sees the bug live.
  NOT_REPRODUCED  auto-clean the instance (likely already fixed).  Verdict
                  + any screenshot still shown.
```

## Decisions (locked 2026-06-12)

| Topic | Decision |
|---|---|
| Categories v1 | api, search, console, storefront-html (headless) + admin-ui / visual (browser) |
| Backends | headless = curl + `swctl exec` bin/console; browser = Playwright via Shopware's `tests/acceptance/` + `@shopware-ag/acceptance-test-suite` |
| Spec source | AI emits `scenarioYaml` OR `playwrightSpec` in the brief; reviewable/editable before run |
| Analyze | one-shot (no tools), 15-40 s, streamed logs + progress bar (4 phases) |
| Issue picker | Browse-GitHub list (assigned, **issues only — not PRs**) + manual URL |
| Labels | plugin scope DERIVED from `extension/*` (authoritative, overrides AI); tags seeded from `domain/*`,`component/*`,`area/*` |
| Run shape | one click: create + seed + run + verdict |
| DB baseline | reset to clean DB before seeding (deterministic) |
| Verify↔human | **one instance** — verify, then hand the same one to the human |
| Keep on REPRODUCED | yes, running, in reproduced state |
| Keep on NOT_REPRODUCED | auto-clean |
| Where it lives | `/repro` page (gated on resolveEnabled); CLI `swctl repro` underneath |

## Scenario file — `.swctl/repro.yml`

```yaml
issue: 10833
db: clean            # clean (default) | demo
setup:
  - product:  { name, price, stock }
  - customer: { email, group }
  - admin-api: { method, path, body }
  - console:  "dal:refresh:index"
execute:
  - request:  { method, path, follow_redirects?, headers? }
  - console:  "<bin/console …>"
assert:
  - status: 200
  - json_path:    { path: ".total", equals: 42 }
  - body_contains:     "…"
  - body_not_contains: "…"
  - exit_code: 0
  - stderr_contains: "…"
```

Step-output variables: a setup step's result is referenceable later as
`{{productId}}` etc. (the AI already drafts this threading).

Verdict semantics: the scenario asserts the **correct** (fixed)
behaviour. Assertions PASS → NOT_REPRODUCED (exit 0). Assertions FAIL →
REPRODUCED (exit 1). So `swctl repro` drops into CI / review gates.

## Browser spec — `.swctl/repro.spec.ts`

Runs inside the worktree's `tests/acceptance/` with `APP_URL` pointed at
the instance.  Uses `@fixtures/AcceptanceTest`, injected page-object
fixtures, `test.step`, `ShopCustomer.*`, `TestDataService`.  MANDATORY
`page.screenshot({ path: process.env.SWCTL_REPRO_SCREENSHOT })` at the
assertion that proves the bug.  Asserts correct behaviour (failing run =
reproduced), same verdict semantics as headless.

## Artifacts

Written to a DURABLE location first — `~/.local/state/swctl/repro/<issue>/<ts>/`
— so they survive instance auto-clean on NOT_REPRODUCED:
- `brief.md`, `repro.yml` | `repro.spec.ts`
- `screenshot.png`, `trace.zip` (browser)
- `verdict.json` { verdict, durationMs, assertions[] }

On REPRODUCED, also copied into the worktree's `.swctl/` so they ride
the PR.

## Build order

- [x] 1.1  brief generator (POST + SSE stream)
- [x] 1.2  /repro page (picker, tags, brief panel)
- [x] 1.2a streamed analyze (logs + progress bar)
- [x] 1.3a brief emits Playwright spec for UI issues
- [ ] 1.3b runner: headless backend (`swctl repro`, YAML, curl/exec) + bats
- [ ] 1.3c runner: Playwright backend + artifact capture + bats
- [ ] 1.4  wire "Reproduce": create(+reset)→seed→run→verdict→hand-off,
           streamed to /repro, inline screenshot, verdict-gated cleanup

## Known caveats

- **Browser seed persistence:** Playwright specs that seed via
  `TestDataService` may roll back on teardown, so the live hand-off
  instance might not show the seeded state.  The screenshot is the
  guaranteed evidence; the live instance is best-effort.  If this bites,
  move seeding to the scenario `setup:` (swctl, persists) and have the
  spec only drive + assert.
- **Reset cost:** clean-DB reset adds ~30 s per run.  Acceptable for
  determinism; revisit if batch repro is ever added.
- **AI setup correctness:** setup steps are AI-drafted — the review/edit
  gate before running is the safety net.
