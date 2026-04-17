# Shopware DAL Troubleshooting Guide

Use for issues touching filters, criteria, joins, inheritance, entity loading, or listing inconsistencies.

## Common DAL symptom classes

- filter returns too many rows
- filter returns zero rows unexpectedly
- manual assignment vs stream assignment inconsistency
- SQL generated from nested AND/OR logic behaves incorrectly
- aggregation/count/listing mismatch
- inheritance or association loading mismatch

## High-risk DAL areas

- `Dbal/JoinGroupBuilder`
- filter parsing and criteria normalization
- to-many association joins
- primary-key repetition on the same association path
- aggregation builders and grouping semantics

## Heuristics

- bug appears in both admin preview and storefront -> suspect shared DAL/core path
- same association path used multiple times under `AND` -> inspect join grouping behavior
- same-row semantics vs separate-exists semantics -> verify whether filters should share or split joins
- count differs from visible rows -> inspect aggregation/query mismatch and indexing side effects

## Verification checklist

- define the minimal entities needed
- state expected SQL semantics in plain language
- compare actual SQL meaning, not only PHP intent
- check whether cache or index state can mask the bug
- verify whether the issue is deterministic

## Safe-fix principles

- prefer narrow DAL fixes over broad query rewrites
- avoid changing unrelated join semantics
- explicitly protect same-row-valid combinations
- add at least one regression test at DAL level
