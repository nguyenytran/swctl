# Shopware Admin and Storefront Build Rules

Use this to decide the minimum environment work needed after code changes.

## No JS build usually needed

- PHP core logic only
- DAL/query/filter changes
- service wiring/config changes
- PHPUnit/integration-only test changes

## Admin build usually needed

- files under `src/Administration`
- Meteor/admin component changes
- admin module JS/Vue/Twig changes
- admin preview UI behavior changes tied to built assets

## Storefront build usually needed

- files under `src/Storefront/Resources`
- storefront JS plugin changes
- storefront Twig/assets changes
- behavior that depends on compiled storefront assets

## DB/reset/reindex signals

Use stronger environment reset when changes touch:
- migrations/schema assumptions
- indexers/search/product keyword/index state
- category/product assignment semantics affected by indexes
- inheritance/materialized data behavior

## Always state explicitly in step 3

- admin build needed: yes/no
- storefront build needed: yes/no
- DB reset/new DB needed: yes/no
- cache clear needed: yes/no
- DAL reindex needed: yes/no

## Preferred principle

Use the lightest setup that can validate the issue correctly, but do not skip environment work that would invalidate the result.
