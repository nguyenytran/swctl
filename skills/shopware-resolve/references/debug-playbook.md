# Shopware 6 Debug Playbook

## Quick Triage

- Confirm exact failing endpoint/command/event and expected behavior.
- Gather timestamps and correlate with deployment, migration, or config changes.
- Identify blast radius: single tenant, all requests, admin-only, storefront-only, async workers.

## Failure Buckets

### Runtime and Dependency

- Verify PHP version and required extensions.
- Verify `composer.lock` consistency and autoload health.
- Check container image/version drift between environments.

### Cache and Compilation

- Check stale container cache, template cache, and JS build artifacts.
- Rebuild/clear caches and warmup before concluding code is faulty.
- Validate environment-specific config values used at compile time.

### Database and Migration

- Verify pending/failed migrations.
- Check schema mismatch between expected entity definitions and actual DB.
- Look for lock waits, deadlocks, and missing indexes on hot queries.

### Plugin and App Integration

- Disable suspect plugin/app and re-test core path.
- Confirm lifecycle state: installed, activated, upgraded, and compatible versions.
- Check event subscribers and decorators for order/priority conflicts.

### Async and Messaging

- Check queue backlog and failed messages.
- Verify scheduled task health and worker concurrency.
- Correlate retries with idempotency issues.

## Root-Cause Workflow

- Build one hypothesis at a time.
- Create the smallest verification step that can falsify that hypothesis.
- Record evidence and confidence after each step.
- Stop once a single causal chain explains all key symptoms.

## Fix Strategy

- Start with tactical mitigation to restore service.
- Apply targeted code/config fix with minimal surface area.
- Add regression tests close to the failing behavior.
- Document why the issue happened and which guardrail prevents recurrence.
