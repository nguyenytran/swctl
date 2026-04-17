# Shopware MCP Dev Integration Guide

Use this guide to make `shopware-local` MCP-grounded when solving Shopware issues.

## Scope

This does **not** fine-tune the base model.
It trains behavior by enforcing a docs-first retrieval workflow through Shopware MCP.

## Local MCP source

- Local repo: `/Users/ytran/Shopware/dev-mcp`
- Project: `shopware-ai-mcp`
- Expected usage: MCP-backed Shopware docs and platform context lookup before analysis and implementation.

## Required behavior for `shopware-local`

- Before making claims about Shopware platform behavior, query MCP evidence first.
- If MCP does not provide clear evidence, mark confidence down and ask for verification.
- Do not replace step-gates:
  - step 1 verify first
  - step 2 root-cause hypotheses only after user approval
  - step 3 implementation only after user approval

## MCP-first flow by step

### Step 1 (clarify + verify)
- use MCP to validate version/platform semantics and expected behavior
- check if issue description conflicts with official docs behavior
- collect docs evidence before deciding reproducibility status

### Step 2 (root-cause hypotheses)
- use MCP context to rank hypotheses
- map each hypothesis to likely Shopware subsystem and code path
- avoid speculative hypotheses when MCP evidence contradicts them

### Step 3 (implementation)
- use MCP docs/context to verify the chosen fix direction aligns with platform behavior
- use MCP to check adjacent components likely affected (regression risk)

## Confidence policy

- `high`: MCP evidence + local code path both agree
- `medium`: local code path suggests cause, MCP evidence partial
- `low`: weak or conflicting evidence; ask user to confirm before advancing

## Output requirements when MCP is used

Always include:
- MCP evidence summary (short)
- affected subsystem guess
- confidence level
- unresolved unknowns

## Failure mode handling

If MCP is unavailable:
- state MCP unavailable explicitly
- continue with local-code evidence only
- lower confidence
- ask user whether to proceed

## Practical note

Training here means improving agent process and evidence discipline, not model-weights training.
