/**
 * Failure-pattern library — curated list of "this looks like X" matchers
 * for the resolve stream's failure card.
 *
 * History: the swctl session that built v0.5.10 hit four distinct
 * first-time-painful failures (bwrap sandbox, alpine pull, branch
 * protection, missing PAT scope) over ~3 hours.  Each one took ~30 min
 * to diagnose from cryptic error fragments.  Pattern-matching common
 * causes turns those fragments into "this looks like X — try Y" before
 * the user opens devtools.
 *
 * Adding a pattern: append to PATTERNS below.  Keep regexes specific
 * (the failure card shows ALL matched patterns, so over-broad regexes
 * generate false-positive hints that erode trust).  When unsure, scope
 * the regex to the specific subsystem ('bwrap:' prefix, 'spawn ... ENOENT'
 * suffix, etc.).
 */

export type FailureCategory = 'sandbox' | 'auth' | 'docker' | 'git' | 'binary' | 'runtime' | 'shopware'

export interface FailurePattern {
  /** Stable id for tooling — never changes once shipped. */
  id: string
  /** Short label rendered as the panel header in the failure card. */
  title: string
  /** Bucket for filtering / grouping — UI may color-code by category. */
  category: FailureCategory
  /**
   * One or more regex patterns; if ANY matches the captured log
   * tail, the pattern is reported as a match.  Test against the
   * combined stdout + stderr stream of the agent process.
   */
  match: RegExp[]
  /**
   * Plain-English remediation, ≤2 short paragraphs.  May contain
   * inline code via backticks (rendered as <code>) and bare URLs
   * (rendered as links).  No HTML — the UI escapes everything else.
   */
  hint: string
}

export interface MatchedPattern {
  id: string
  title: string
  category: FailureCategory
  hint: string
  /** First line from the log that triggered the match — useful evidence in the UI. */
  evidence: string
}

const PATTERNS: FailurePattern[] = [
  // ── Codex sandbox in container ─────────────────────────────────────────
  {
    id: 'codex-bwrap-sandbox',
    title: 'Codex sandbox blocked by container kernel',
    category: 'sandbox',
    match: [
      /bwrap: No permissions to create a new namespace/i,
      /kernel.unprivileged_userns_clone/i,
    ],
    hint:
      "Codex's `--full-auto` mode uses bubblewrap (bwrap) for workspace-write " +
      "sandboxing, which needs `kernel.unprivileged_userns_clone=1` — not " +
      "available in the swctl-ui Alpine container.\n\n" +
      "Fix: switch to `--dangerously-bypass-approvals-and-sandbox`. The " +
      "swctl-ui container is already the sandbox boundary; a second bwrap " +
      "layer adds no security and breaks every file write.  This was " +
      "fixed in PR #6 — make sure your trunk is up to date.",
  },

  // ── Docker daemon / image issues ───────────────────────────────────────
  {
    id: 'docker-daemon-down',
    title: 'Docker daemon not reachable',
    category: 'docker',
    match: [
      /Cannot connect to the Docker daemon/i,
      /docker:.*Is the docker daemon running/i,
    ],
    hint:
      "The agent tried to run a docker command but the daemon isn't " +
      "responding.\n\n" +
      "Fix: start Docker Desktop / OrbStack and retry. If the daemon is " +
      "running, check `docker info` works from your shell — if it " +
      "doesn't, the issue is host-side (socket permissions, OrbStack " +
      "stopped, etc.).",
  },
  {
    id: 'docker-keychain-credential-helper',
    title: 'Docker pulling via macOS keychain in Linux container',
    category: 'docker',
    match: [/docker-credential-osxkeychain.*not found/i],
    hint:
      "The Linux container is inheriting your host's `~/.docker/config.json`, " +
      "which points at the macOS-only `osxkeychain` credential helper. " +
      "Pulls fail because that binary doesn't exist inside Alpine.\n\n" +
      "Fix: pull with an empty `DOCKER_CONFIG` directory (already done " +
      "for `swctl init` in PR #4).  If you hit it elsewhere, set " +
      "`DOCKER_CONFIG=/tmp/empty` for the failing command.",
  },

  // ── Git / branch protection ────────────────────────────────────────────
  {
    id: 'git-branch-protection',
    title: "Git push rejected by branch protection",
    category: 'git',
    match: [
      /GH006: Protected branch update failed/i,
      /protected branch hook declined/i,
    ],
    hint:
      "The push was rejected because the target branch requires status " +
      "checks before any update.  This is the classic problem for " +
      "auto-commit workflows on `main`.\n\n" +
      "Fix: open a PR for the change instead of pushing direct, OR " +
      "configure the branch ruleset to allow the bot.  See PR #9 for the " +
      "release-workflow fix that hit this exact wall.",
  },
  {
    id: 'git-branch-already-exists',
    title: "Git: branch already exists at a stale commit",
    category: 'git',
    match: [
      /fatal:.*A branch named .* already exists/i,
      /fatal:.*not a valid object name/i,
    ],
    hint:
      "The branch `swctl create` wanted to use is already present at a " +
      "stale commit (probably from a half-failed prior create that " +
      "didn't write metadata, so `swctl clean` couldn't sweep it).\n\n" +
      "Fix: `swctl clean <issue>` now sweeps orphan branches automatically " +
      "(PR #15+).  Alternatively `git branch -D <branch>` in the project " +
      "root, then retry.",
  },

  // ── Binary missing ─────────────────────────────────────────────────────
  {
    id: 'binary-not-found-enoent',
    title: 'Required binary not on PATH',
    category: 'binary',
    match: [
      /spawn (\S+) ENOENT/i,
      /^bash: (\S+): command not found/im,
      /(\S+): No such file or directory/i,
    ],
    hint:
      "The agent tried to spawn a command that isn't on its PATH.  " +
      "Common offenders: `gh` (GitHub CLI), `codex` (Codex CLI), " +
      "`claude` (Claude Code CLI), `jq`, `composer`.\n\n" +
      "Fix: install the missing binary on the host, OR set the explicit " +
      "path in `~/.swctl/config.json` under `ai.<backend>.bin` (for AI " +
      "CLIs).  The Test CLI button on the /config page exercises the " +
      "spawn path against the configured binary.",
  },

  // ── GitHub auth ────────────────────────────────────────────────────────
  {
    id: 'gh-auth-403-pat-scope',
    title: 'GitHub PAT lacks required permission',
    category: 'auth',
    match: [
      /Resource not accessible by personal access token/i,
      /HTTP 403.*Resource not accessible/i,
    ],
    hint:
      "The fine-grained PAT in use can READ the resource but not write " +
      "it (or vice-versa).  Most common cause: token created with " +
      "`Contents: Read` instead of `Read and write`.\n\n" +
      "Fix: edit the token at https://github.com/settings/personal-access-tokens " +
      "and switch the offending permission to read+write.  No need to " +
      "rotate — the existing value still works once permissions are " +
      "broadened.",
  },

  // ── Shopware platform-specific ─────────────────────────────────────────
  {
    id: 'shopware-db-connection',
    title: 'Shopware: database connection refused',
    category: 'shopware',
    match: [
      /SQLSTATE\[HY000\] \[2002\]/i,
      /could not connect to MySQL server/i,
      /MariaDB.*Connection refused/i,
    ],
    hint:
      "The Shopware container can't reach its database.  Either the " +
      "shared mariadb container is stopped, or the per-instance DB " +
      "wasn't cloned.\n\n" +
      "Fix: `swctl init` ensures the shared mariadb runs.  For per-instance " +
      "DBs, check `docker ps` — the worktree's compose project name is " +
      "`<project>-<issueId>`.  The preflight (PR #13) catches the shared-" +
      "mariadb case before create runs.",
  },
  {
    id: 'shopware-composer-install',
    title: 'Shopware: composer install failed',
    category: 'shopware',
    match: [
      /Your requirements could not be resolved to an installable set/i,
      /composer\.lock.*does not contain enough information/i,
    ],
    hint:
      "Composer can't reconcile the package versions.  Often happens " +
      "when a plugin's composer.json pins to an incompatible Shopware " +
      "version range, or a private Packagist credential is missing.\n\n" +
      "Fix: read the `composer install` output for the specific " +
      "conflicting package.  For private deps, ensure `~/.composer/auth.json` " +
      "has the right token and is mounted into the container.",
  },
  {
    id: 'shopware-non-existent-service',
    title: 'Shopware: DI compile failed — non-existent service',
    category: 'shopware',
    // Symfony's exact wording when one service references another that
    // isn't registered.  Common during multi-plugin platform creates
    // when one plugin's services.xml references a class from another
    // plugin that isn't in the LINKED_PLUGINS set.
    match: [
      /You have requested a non-existent service ['"]([^'"]+)['"]/i,
      /Service ['"]([^'"]+)['"] not found/i,
    ],
    hint:
      "The container compile failed because one plugin's services.xml " +
      "references a class from another plugin that isn't loaded in this " +
      "instance.  Most common case: SwagCustomizedProducts uses " +
      "`Shopware\\Commercial\\Licensing\\Features` but SwagCommercial " +
      "isn't in your `.swctl.deps.yaml`.\n\n" +
      "Fix: add the missing plugin to the `plugins:` list in " +
      "`<project>/.swctl.deps.yaml`, or pass it via " +
      "`swctl create --deps <Plugin1>,<Plugin2>`.  Then `swctl clean " +
      "<issue> && swctl create ...` to rebuild from scratch.  If the " +
      "missing plugin is a transitive dep that should always be present, " +
      "add a `requires` entry to the depending plugin's composer.json so " +
      "swctl can detect it on next iteration.",
  },
]

/**
 * Match the captured log buffer against the pattern library.  Returns
 * every matched pattern (the failure card may render multiple — there's
 * often more than one root cause in the chain).
 *
 * Iteration is over the static PATTERNS list, regex test on each.  At
 * 9 patterns × ~50KB log buffer this is well under 10ms.  No throttle
 * needed; called only on stream close.
 */
export function matchFailurePatterns(logTail: string): MatchedPattern[] {
  if (!logTail || typeof logTail !== 'string') return []
  const matched: MatchedPattern[] = []
  for (const p of PATTERNS) {
    for (const re of p.match) {
      const m = re.exec(logTail)
      if (m) {
        // Capture the full line containing the match for evidence.
        const lineStart = logTail.lastIndexOf('\n', m.index) + 1
        const lineEnd = logTail.indexOf('\n', m.index)
        const evidence = logTail
          .slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
          .trim()
          .slice(0, 240)
        matched.push({
          id: p.id,
          title: p.title,
          category: p.category,
          hint: p.hint,
          evidence,
        })
        break  // first matcher per pattern is enough; don't double-count
      }
    }
  }
  return matched
}

/** Exported for tests + debugging — count of patterns currently registered. */
export function patternCount(): number {
  return PATTERNS.length
}
