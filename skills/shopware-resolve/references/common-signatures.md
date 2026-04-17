# Common Error Signatures

Use in Step 1.1 to classify errors by family, and in Step 1.2 to generate search keywords from error patterns.
When `scripts/parse-shopware-errors.sh` outputs a signature, match it against the patterns below to identify the subsystem before searching.

## Container and DI

- `Cannot autowire service ...`: service wiring mismatch, missing alias, or constructor change.
- `Class ... not found`: autoload mismatch, removed class, namespace drift, or stale cache.

## Database and DAL

- `SQLSTATE[42S22] Column not found`: migration missing or schema drift.
- `Deadlock found when trying to get lock`: concurrent writes with poor lock ordering.
- `Lock wait timeout exceeded`: long transaction, missing index, or blocking query.

## Plugin and App Lifecycle

- `Plugin ... is not active`: plugin state mismatch after update/deploy.
- `App ... registration failed`: app secret/config mismatch or callback accessibility issue.

## Messaging and Async

- `Message handling failed after retries`: non-idempotent handler or poison message.
- `No handler for message`: transport config mismatch or handler not registered.

## HTTP and Integration

- `401/403` from app webhook: signature/secret mismatch or ACL/permission issue.
- `5xx` after deployment: container cache drift, env config mismatch, or migration race.
