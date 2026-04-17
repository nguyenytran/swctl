# Issue Triage Taxonomy

Use this reference when triaging Shopware issues into normalized `severity`, `domain`, and optional `component`.

## Output schema

- `severity`: one of `security-related`, `critical`, `high`, or `low`
- `effort`: one of `easy`, `medium`, or `hard`
- `domain`: one domain label from the list below
- `component`: optional component label; omit it when the fit is weak

## Evidence order

1. Ignore the issue's current domain/component labels as evidence.
2. Inspect any class or file mentioned in the ticket. Prefer its package annotation such as `#[Package('framework')]`.
3. Use the ticket title and description as secondary evidence.
4. If the ticket mentions commits, PRs, or other issues, inspect those artifacts with the same order:
   - for a commit, inspect the touched files and their package annotations;
   - for a PR or issue, inspect its description and touched files;
   - if a referenced issue already has a fixing or routing PR, use that PR's touched files and package annotations as supporting evidence.
5. If the evidence stays split, choose the smallest defensible owner domain and leave `component` empty.

## Fast triage mode

Prefer `gh` for issue triage to keep latency low:

1. Read issue payload and comments via `gh issue view`.
2. Parse only explicit references in the issue text: classes/files, PRs, commits, and linked issues.
3. Fetch only referenced artifacts via `gh pr view` and `gh api` commit endpoints.
4. Use local `git`/`rg` only when:
   - a mentioned class/file needs package annotation verification, or
   - remote evidence is incomplete/contradictory.
5. Avoid broad repo-wide scans in first pass.

## Severity rubric

- `security-related`: authentication, authorization, privilege escalation, injection, secret leakage, insecure defaults, or any vulnerability report
- `priority/critical`: production outage, checkout blocking, data loss/corruption risk, install/update blocker, or no viable workaround for a core flow
- `priority/high`: major feature broken, severe regression, major performance degradation, admin lockout, or workaround exists but is costly
- `priority/low`: minor bug, narrow edge case, cosmetic issue, docs/tests/tooling cleanup, or a problem with limited business impact

## Effort rubric

- `easy`: localized fix, low coupling, no schema/migration changes, low regression risk, typically one area/component
- `medium`: multiple files/modules, moderate coupling, careful regression validation needed, but no major architectural change
- `hard`: cross-domain impact, migration or compatibility concerns, high coupling, high validation scope, or unclear root cause requiring substantial investigation

## Package-to-domain mapping

Use package annotations as the primary routing signal when they map cleanly to a domain label.

| Package value | Domain label | Notes |
| --- | --- | --- |
| `after-sales` | `domain/crm-after-sales` | Package name and label name differ |
| `b2b` | `domain/b2b` | Use when present in package or code area |
| `checkout` | `domain/checkout` | |
| `discovery` | `domain/discovery` | |
| `dx-tools` | `domain/dx-tools` | Use when package or code area clearly targets developer tooling |
| `framework` | `domain/framework` | |
| `fundamentals@after-sales` | `domain/crm-after-sales` | Map by suffix |
| `fundamentals@discovery` | `domain/discovery` | Map by suffix |
| `fundamentals@framework` | `domain/framework` | Map by suffix |
| `inventory` | `domain/inventory` | |
| `product-ops` | `domain/product-ops` | Use only with explicit evidence |
| `quality-ops` | `domain/quality-ops` | Use only with explicit evidence |
| `service-enablement` | `domain/service-enablement` | Use only with explicit evidence |
| `ux` | `domain/ux` | Use only with explicit evidence |

Package values such as `cause`, `command`, `controller`, `data-services`, and `exception` are not enough on their own to map to a domain label. Use surrounding code paths, the ticket description, and referenced PRs/issues instead of guessing.

## Domain labels

| Label | Description |
| --- | --- |
| `domain/b2b` | Responsible for the B2B functionalities |
| `domain/checkout` | Responsible for fulfilling the buying transaction inside the store and everything related to it |
| `domain/crm-after-sales` | Responsible for all processes that are bundled and kicked off after the initial checkout |
| `domain/customer-support` | Deprecated: use `customer-support` label instead |
| `customer-support` | For Shopware Customer Support to report User Stories and Bugs from customers |
| `domain/discovery` | Responsible for enabling the shopper to discover precisely the products that they want |
| `domain/dx-tools` | Responsible for developer experience tooling |
| `domain/framework` | Responsible for the framework-level code includes core, administration, storefront, and frontends |
| `domain/inventory` | Responsible for managing products and everything product-related |
| `domain/product-ops` | Responsible for Product Operations |
| `domain/quality-ops` | Responsible for Quality Operations |
| `domain/service-enablement` | Responsible for supporting Shopware services |
| `domain/ux` | Responsible for user experience topics |

## Domain owners

Use owners only as a post-routing lookup after the domain has been selected from code and ticket evidence.

| Domain label | Team handle | Responsibility highlights |
| --- | --- | --- |
| `domain/framework` | `shopware/product-cc-framework` | DAL, migrations, app system, caching, ACL, feature toggles, storefront framework, admin core, message queue, telemetry, extension lifecycle, rate limiting, installer, webhooks, security plugin, licensing |
| `domain/inventory` | `shopware/product-cc-inventory` | products, product streams, properties, manufacturer, SEO, search, product exports, measurements, advanced search, multi warehouse, bundles |
| `domain/discovery` | `shopware/product-cc-discovery` | snippets/translations, media, categories, sales channels, sitemaps, delivery times, customer groups, shopping experiences, wishlist, theme management admin UI |
| `domain/checkout` | `shopware/product-cc-checkout` | promotions, customer account, payment, checkout, shipping, cart, signup, orders, tax, salutation, subscriptions, shopper SSO |
| `domain/crm-after-sales` | `shopware/product-cc-after-sales` | product reviews, admin dashboard, documents, email templates, flow builder, newsletter recipients, return management |
| `domain/b2b` | `shopware/product-cc-b2b` | employee management, order approvals, quote management, quick orders, shopping lists, organization units, B2B suite, digital sales rooms, sales agent |
| `domain/product-ops` | not provided | Product Ops |
| `domain/quality-ops` | `shopware/test-engineers` | playwright automation suite and acceptance tests |
| `domain/service-enablement` | not provided | supporting Shopware services |
| `domain/ux` | not provided | user experience topics |
| `customer-support` | not provided | customer support reporting label |
| `domain/customer-support` | deprecated | deprecated alias of `customer-support` |

## Routing cues by domain

Use these cues when package annotations are absent or too generic.

- `domain/framework`: app system, private apps, custom entities, custom fields, number ranges, mailer configuration, queue, telemetry, event logs, extension lifecycle, storefront templates/controllers/themes/build, admin bootstrapping/services/helpers/workers, npm packages, rate limiting, system checks, web installer, webhooks, platform security, licensing, HTML sanitizer
- `domain/inventory`: products, manufacturers, product properties, product streams, product exports, storefront filters, SEO, search, digital products, essential characteristics, scale units, product measurements, advanced search, multi warehouse, customer-specific pricing, bundles, custom products
- `domain/discovery`: snippets, translation UX, media, categories, sales channels, sitemaps, delivery times, customer groups, CMS/shopping experiences, wishlist, theme management admin UI, social shopping, publisher, CMS extensions
- `domain/checkout`: promotions, customer account, payment, cart, checkout, shipping, orders, signup, shopper login, tax, salutations, storefront account, subscriptions, checkout sweetener, shopper SSO, extension store payment/shipping integrations
- `domain/crm-after-sales`: product reviews, dashboard, documents, email templates, flow builder, newsletter recipients, returns, import/export, migration assistant, first run wizard, rule builder maintenance
- `domain/b2b`: employee management, approvals, quotes, quick orders, shopping lists, organization units, budgets and quotas, B2B dashboards, digital sales rooms, sales agent
- `domain/quality-ops`: acceptance tests, playwright suite, test infrastructure ownership signals
- `domain/product-ops`, `domain/service-enablement`, `domain/ux`: assign only with explicit evidence from repo, team mentions, or ticket wording

## Fundamentals routing overrides

The SSOT defines a few fundamentals topics that should route away from their generic surface area:

- tags -> `domain/framework`
- admin user lifecycle, login, profile, permissions, integrations, role management -> `domain/framework`
- currencies -> `domain/framework`
- language and translations -> `domain/discovery`
- countries -> `domain/discovery`
- first run wizard -> `domain/crm-after-sales`
- demo data plugin and `framework:demodata` -> `domain/crm-after-sales`
- import/export -> `domain/crm-after-sales`
- migration assistant, including SW5 connector and Magento profile -> `domain/crm-after-sales`
- rule builder maintenance -> `domain/crm-after-sales`
- Rufus maintenance -> `domain/checkout`

## Service labels

These are not commerce-core domain labels. Keep them as separate ownership references and use them only when the ticket is clearly about a Shopware service or service-owned repository.

| Service label | Scope highlights |
| --- | --- |
| `service/data-intelligence` | Shopware Analytics, Analytics Gateway, Data Pipeline, Entity Gateway, GMV reporting, services UI settings page, product analytics, consent banner behavior in administration |
| `service/business-capabilities` | purchase interface, transaction gateway, recommendations, AI image editor service |
| `service/shopping-experience` | AI proxy, insider previews, 3D preview generation, copilot, CAD-to-GLB pipeline, immersive elements app, AI copilot commercial features, spatial commerce |
| `service/pipe-fiction` | Nexus Databus |

## Component labels

The supplied component list had empty descriptions, so keep the names as routing candidates and omit `component` when none is a strong fit.

| Label | Description |
| --- | --- |
| `component/administration` | |
| `component/advanced-search` | |
| `component/appstore` | |
| `component/appsystem` | |
| `component/categories` | |
| `component/core` | |
| `component/customer-groups` | |
| `component/customfields` | |
| `component/dashboard` | |
| `component/demo-data` | |
| `component/documents` | |
| `component/e2e-playwright` | |
| `component/email-templates` | |
| `component/event-logs` | |
| `component/extension-store` | |
| `component/first-run-wizard` | |
| `component/flowbuilder` | |
| `component/import-export` | |
| `component/installer` | |
| `component/inventory-dynamic-products` | |
| `component/inventory-manufacturers` | |
| `component/inventory-products` | |
| `component/inventory-properties` | |
| `component/product-reviews` | |
| `component/legal-app` | |
| `component/mailer` | |
| `component/media` | |
| `component/meteor` | |
| `component/newsletter-recipients` | |
| `component/pipeline` | |
| `component/plan-booking` | |
| `component/product-analytics` | |
| `component/promotions` | |
| `component/rulebuilder` | |
| `component/sales-channels` | |
| `component/search` | |
| `component/security-plugin` | |
| `component/seo` | |
| `component/settings-countries` | |
| `component/settings-currency` | |
| `component/settings-essential-characteristics` | |
| `component/settings-languages` | |
| `component/settings-newsletter` | |
| `component/settings-number-ranges` | |
| `component/settings-products` | |
| `component/settings-salutations` | |
| `component/settings-scale-units` | |
| `component/settings-tags` | |
| `component/settings-warehouses` | |
| `component/shopping-experiences` | |
| `component/shopware-account` | |
| `component/signup` | |
| `component/sitemap` | |
| `component/snippets` | |
| `component/sso` | |
| `component/storefront` | |
| `component/subscriptions` | |
| `component/updater` | |
| `component/users-permissions` | |
| `component/wishlist` | |
