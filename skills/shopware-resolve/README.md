# Shopware Resolve Skill

Portable skill pack for structured Shopware issue resolution: triage, root-cause analysis, fix implementation, independent review, Flow Builder impact assessment, validation, and PR preparation.

## What this skill does

An 8-step gated workflow that takes a Shopware issue from report to merge-ready fix:

1. **Verify the issue** - Reproduce and frame the incident
2. **Find root cause** - Identify why the bug happens
3. **Implement the fix** - Write the safest minimal fix in an isolated worktree
4. **Independent review** - Sub-agent critically reviews the patch
5. **Flow Builder impact** - Assess effect on automation flows
6. **Test and validate** - Run tests, static analysis, code style
7. **Prepare for merge** - Commit conventions, PR preparation
8. **Decision-ready output** - Final aggregated triage summary

Every step requires explicit user approval before proceeding.

## Included skills

- `shopware-resolve`: `SKILL.md`

## Structure

```
shopware-troubleshoot-skill/
  SKILL.md                    # Main skill definition (8-step workflow)
  README.md                   # This file
  validate-all-skills.sh      # Skill format validation
  references/                 # Domain-specific knowledge (loaded as needed)
    branch-naming-conventions.md
    flow-builder-impact-guide.md
    shopware-platform-map.md
    shopware-dal-guide.md
    shopware-product-stream-guide.md
    shopware-local-worktree-playbook.md
    shopware-admin-storefront-build-rules.md
    shopware-mcp-dev-integration.md
    debug-playbook.md
    trunk-debug-commands.md
    common-signatures.md
    issue-triage-taxonomy.md
    source-map.md
    search-troubleshooting.md
    prompt-cheat-sheet.md
  scripts/                    # Automation utilities
    create-issue-worktree.sh  # Create worktree + branch from issue
    analyze-flow-impact.sh    # Assess Flow Builder impact from diff
    prepare-pr.sh             # Generate commit message and PR body
    read-github-issue.sh      # Fetch GitHub issue with comments
    triage-github-issues.sh   # Batch issue triage
    post-github-issue-comment.sh
    collect-shopware-context.sh
    inspect-plugin-state.sh
    parse-shopware-errors.sh
    search-shopware-sources.sh
    read-web-doc.sh
  agents/                     # Agent prompts
    review-agent.md           # Independent code review agent
    openai.yaml               # Agent interface metadata
```

## Runtime requirements

- `bash`
- `python3` (with `PyYAML`) only for validation script
- Optional: `gh`, `jq`, `curl`, `git`, `rg`

## Environment variables

- `SHOPWARE_ROOT`: Optional path to a Shopware codebase. Default: `$PWD`.
- `CODEX_HOME`: Optional Codex home override. Default: `$HOME/.codex`.
- `PYTHON_BIN`: Optional python executable. Default: `python3`.

## Quick validation

```bash
bash shopware-troubleshoot-skill/validate-all-skills.sh
```

## Usage

Invoke the skill with a Shopware issue:

```text
$shopware-resolve resolve this issue: shopware/shopware#15934
$shopware-resolve triage these 15 issues and rank by urgency
$shopware-resolve checkout throws 500 after plugin update; find root cause and fix
$shopware-resolve search results wrong after changing analyzers; diagnose and fix
```

## Usage in other agents

If an agent does not support skills natively:
1. Open `SKILL.md`.
2. Copy the workflow sections into your system/task prompt.
3. Run the referenced scripts manually as needed.

## Output convention

- Markdown links for referenced commits, PRs, and issues
- Repository label names for routing (`priority/high`, `domain/inventory`)
- GitHub team handles (`@shopware/product-cc-inventory`) when supported by taxonomy
- Deterministic triage template in `SKILL.md` Step 8
- Optional fields omitted when not supported by evidence
