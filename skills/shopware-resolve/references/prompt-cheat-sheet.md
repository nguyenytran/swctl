# Shopware Troubleshoot Skill Prompt Cheat Sheet

## 1) Core Prompt
$shopware-troubleshoot-skill <your request>

Prefer specifying the local Shopware repo/worktree up front so the skill does not need to ask broad repo questions in the main chat flow.

Examples:
- $shopware-troubleshoot-skill use local repo /Users/ytran/Shopware/trunk, investigate issue #8221 with step 1 only
- $shopware-troubleshoot-skill use local worktree /Users/ytran/Shopware/worktrees/15916, verify whether this issue is still reproducible before doing anything else
- $shopware-troubleshoot-skill triage these issues by severity, effort, owner, and next action: <issue-list>
- $shopware-troubleshoot-skill checkout fails after plugin update, find root cause and fix direction
- $shopware-troubleshoot-skill admin product save started failing after upgrading to 6.7-dev

---

## 2) Issue Triage
$shopware-troubleshoot-skill <triage task>

### Single issue triage
- $shopware-troubleshoot-skill classify this issue by severity, effort, domain, owner, and likely fix path: https://github.com/shopware/shopware/issues/14372

### Batch triage
- $shopware-troubleshoot-skill triage these issues for severity/effort/priority with short reasoning:
  https://github.com/shopware/shopware/issues/13812, https://github.com/shopware/shopware/issues/15120

### Strong triage output contract
- $shopware-troubleshoot-skill triage <issue-url> and return:
  1) Severity
  2) Effort
  3) Domain/Owner
  4) Priority Reasoning
  5) Likely Fix Path
  6) Evidence Trail

---

## 3) Single Issue Analysis
$shopware-troubleshoot-skill <task>

### Single issue deep analysis
- $shopware-troubleshoot-skill find root cause and how to fix this issue https://github.com/shopware/shopware/issues/14372
- $shopware-troubleshoot-skill analyze https://github.com/shopware/shopware/issues/15120 with exact files, likely commit evidence (if regression), patch direction, validation checklist

### Strong output contract (recommended)
- $shopware-troubleshoot-skill analyze <issue-url> and return in markdown:
  1) Summary
  2) Likely Root Cause
  3) Fix Direction
  4) Validation Checklist
  5) Evidence Commits (only if defensible)
  6) Exact Files

### Repo/local context aware
- $shopware-troubleshoot-skill investigate this issue using local code in ${SHOPWARE_ROOT:-$PWD}: <issue-url>

---

## 4) Search/OpenSearch Issues

### Search diagnostics
- $shopware-troubleshoot-skill diagnose why OpenSearch ranks the wrong products first for query "<term>"

### Advanced Search and fallback checks
- $shopware-troubleshoot-skill inspect this issue for analyzer/query/fallback problems and tell me whether it is Core Search, OpenSearch, Advanced Search, or mixed

### Output shape
- $shopware-troubleshoot-skill return suspected layer, likely root cause, safest fix type, reindex need, and validation checklist

---

## 5) Triage-at-scale templates

### Fast batch triage
- $shopware-troubleshoot-skill triage top 20 open bug issues in shopware/shopware by severity, effort, priority and add 1-line priority reasoning each

### Label-focused triage
- $shopware-troubleshoot-skill triage open issues with label "regression" and rank by urgency with fix-effort category

---

## 6) Prompt Add-ons (append these when needed)

- "Keep answer concise and actionable."
- "Assume this is for engineering triage meeting."
- "Prefer minimal, reversible fix."
- "Include confidence level."
- "If no clear introducing commit, explicitly say 'likely new bug'."

---

## 7) Best-practice input checklist (for better results)

Include:
- Shopware version
- Expected vs actual behavior
- Reproduction steps
- Affected area (checkout, search, product export, etc.)
- Relevant plugins/apps enabled
- Logs/error snippets (if available)
