# Search Troubleshooting

Use this reference when the incident touches Shopware search behavior.

## When to use

- Search relevance, ranking, analyzer, or tokenization issues.
- Elasticsearch/OpenSearch query behavior and scoring issues.
- Advanced Search behavior in SwagCommercial.

## Workflow

1. Classify the suspected layer first: `Elasticsearch`, `Core Search`, `Advanced Search`, or `Mixed`.
2. Collect evidence:
   - Query payload or generated query shape
   - Analyzer output
   - Explain output
   - Expected vs actual top results
3. Choose fix type:
   - `Query-only`
   - `Analyzer+Reindex`
   - `Config-only`
   - `UX`
4. Return a decision-ready recommendation with validation steps.

## Guardrails

- Recommendations must work with OpenSearch 1.x.
- When Elasticsearch/OpenSearch fails, Shopware can fall back to MySQL; account for `SHOPWARE_ES_THROW_EXCEPTION`.
- For Advanced Search, check SwagCommercial extension points before assuming a core-only fix.

## Output contract

Always include:

- `suspected layer`: `Elasticsearch`, `Core Search`, `Advanced Search`, or `Mixed`
- `fix type`: `Query-only`, `Analyzer+Reindex`, `Config-only`, or `UX`
- OpenSearch 1.x compatibility note
- Validation checklist with expected top-N behavior and explain/analyzer checks
