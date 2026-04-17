# Source Map

Use this file to expand beyond local references when debugging incidents.

## Trusted documentation domains

- `developer.shopware.com` (official developer docs)
- `docs.shopware.com` (user and admin docs)
- Your Stoplight docs domain (set `STOPLIGHT_BASE_URL`)

## Trusted repository starting points

- `shopware/shopware` (platform core)
- `shopware/SwagCommercial` (commercial platform plugin)
- Team plugin/app repositories (pass via script args or `GH_REPO_FILTERS`)

## Trusted extension repositories

- `shopware/Rufus`
- `shopware/ShopwarePayments`
- `shopware/swagdigitalsalesrooms`
- `shopware/SwagLanguagePack`
- `shopware/frontends`
- `shopware/SwagMigrationAssistant`
- `shopware/SwagCustomizedProducts`
- `shopware/SwagAnalytics`
- `shopware/SwagDynamicAccess`
- `shopware/swagsalesagent`
- `shopware/SwagSocialShopping`

## Fast research commands

```bash
scripts/search-shopware-sources.sh "variant hide closeout"
scripts/search-shopware-sources.sh "ProductConfiguratorLoader" shopware/shopware shopware/SwagCommercial
scripts/search-shopware-sources.sh "newsletter_recipient" shopware/shopware shopware/SwagCommercial shopware/SwagMigrationAssistant
scripts/read-web-doc.sh https://developer.shopware.com/docs
scripts/read-web-doc.sh https://shopware.stoplight.io/docs/store-api full
scripts/triage-github-issues.sh --repo shopware/shopware --issues 15120
scripts/triage-github-issues.sh --repo shopware/shopware --issues 15120,15121 --label "priority/high"
scripts/triage-github-issues.sh --repo shopware/shopware --mode light --limit 100
scripts/triage-github-issues.sh --repo shopware/shopware --mode light --ticket-type all --limit 100
scripts/triage-github-issues.sh --repo shopware/shopware --mode light --ticket-type technical-todo --limit 100
scripts/triage-github-issues.sh --repo shopware/shopware --mode light --label "component/administration" --limit 100
scripts/triage-github-issues.sh --repo shopware/shopware --mode deep --limit 100 --top 20
```

## Research rules

- Prefer official docs and first-party repos first.
- For tickets mentioning Commercial scope (`Extension:Commercial`, `extension/Commercial`), search `shopware/SwagCommercial` in the first pass, then correlate with `shopware/shopware` integration points.
- If the ticket mentions one of the trusted extension repos explicitly, include that repo in first-pass evidence lookup.
- Correlate issue reports with PRs/commits and release versions.
- For regressions, combine web evidence with local `git log` and `git blame` evidence.
