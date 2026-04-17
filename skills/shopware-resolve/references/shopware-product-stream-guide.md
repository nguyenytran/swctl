# Shopware Product Stream Guide

Use for dynamic product groups, product streams, stream preview, category assignment, and listing mismatches.

## Typical symptom clusters

- stream preview returns zero items unexpectedly
- storefront listing differs from admin preview
- dynamic product group does not update after product change
- AND logic across properties/categories behaves incorrectly
- parent/child category assignment semantics are inconsistent

## Core paths to inspect

- product stream builder paths in `Core/Content/ProductStream`
- DAL filter resolution for product associations
- administration preview controllers for product streams
- category listing/product assignment paths
- indexing and cache layers after product/category updates

## Repro checklist

- define one category, one stream, and one minimal product set
- make expected matching logic explicit in plain language
- after data changes, decide whether you must run:
  - `dal:refresh:index`
  - `cache:clear`
  - storefront/admin rebuild steps
- verify preview path and storefront path separately

## Interpretation guide

- admin preview and storefront both wrong -> likely core/shared path
- preview right, storefront wrong -> suspect listing/index/cache path
- preview wrong, storefront untouched -> suspect preview/controller/builder path

## Validation expectations

- add one regression at the stream/DAL level when possible
- add one direct path regression for the affected UI/API path when practical
