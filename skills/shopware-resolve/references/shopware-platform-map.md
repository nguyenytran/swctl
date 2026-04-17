# Shopware Platform Map

Use this as the first orientation layer for `shopware-local`.

## Core areas

- `src/Core`
  - business logic, DAL, checkout, content, framework, system
- `src/Administration`
  - admin JS/Vue modules, Meteor admin UI, extension points
- `src/Storefront`
  - storefront controllers, page loaders, Twig, JS plugins
- `tests/`
  - unit, integration, administration, storefront, e2e-related coverage

## High-value domains

- `Core/Framework`
  - DAL, context, rules, flags, message bus, feature flags
- `Core/Content`
  - product, category, media, SEO, CMS, properties
- `Core/Checkout`
  - cart, order, payment, shipping, promotions
- `Core/System`
  - config, sales channel, indexing, language, state machine

## Search-related areas

- `src/Elasticsearch`
  - OpenSearch/Elasticsearch integration paths
- `Core/Content/Product/SearchKeyword`
  - keyword and indexing paths
- `Core/Framework/DataAbstractionLayer/Search`
  - DAL criteria, filters, aggregations

## Troubleshooting heuristics

- admin-only symptom -> inspect `src/Administration`
- storefront-only symptom -> inspect `src/Storefront`
- same bug in admin preview and storefront -> suspect `src/Core` or DAL/shared services
- SQL/filter/listing inconsistency -> suspect DAL filters, join grouping, indexing, or cache
- behavior changes after product/category edits -> inspect indexing, cache, and inheritance flows

## Default local target

Preferred local repo:
- `/Users/ytran/Shopware/trunk`

If implementation is approved, prefer an issue-number worktree derived from this repo.
