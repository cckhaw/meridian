# Data migration: export, templates and import

**Back office → Data migration** (permissions `migration:export` and `migration:import`; the Administrator role has both) backs up and moves the platform's data. This page describes what is built; the sections for loading data are marked by the release that added them.

## What the engine is made of

| Piece | Where |
|---|---|
| The description of every record type: its fields (type, required, pattern, values, example, sensitivity), its phase, what it depends on, how to read it a page at a time | `packages/core/src/migration/entities.ts` |
| Streaming export (a ZIP built while it downloads), masking, a streaming ZIP64 writer | `migration/export.ts`, `mask.ts`, `zip.ts`, `format.ts` |
| Templates (CSV and JSON), and the registry of their versions | `migration/templates.ts`, table `data_templates` |
| Jobs (who exported or imported what, progress, problems) | `migration/jobs.ts`, tables `migration_jobs`, `migration_job_items` (migration `0031`) |
| Screens and API | `apps/web/src/app/admin/migration`, `/api/migration/*` |

Everything is driven by the entity descriptions, so a new record type is one definition, not a new feature.

## The data sets

| Domain | Data sets |
|---|---|
| **Product** | Catalog structure (network types, categories, groups), offers, offer types, fulfilment options, service types, VIP number tiers (slabs), terms: cancellation and return rules, terms: store terms and privacy links |
| **Customer** | Customer segments, customers, accounts, service groups and their members |
| **Operations** | Stores, dealers, agents, commission plans, rules (with volume slabs), claw-back policies, plan assignments |
| **Subscriber and financial** | Services, SIM inventory (ICCID), IMSI pool, number inventory (MSISDN), sub-ledger balances (trial balance), account balances (receivables), active dunning cases |

Enterprise departments and IoT hierarchies are customers: a department has a parent customer, and an IoT hierarchy is the IoT enterprise segment with its departments. Both are in the customers file (`parent_customer_id`, `segment`), and nested under their parents in JSON.

## Exporting

1. Choose domains or single data sets, the format, and whether to take a very large table in parts. **Export** creates a job and the browser downloads the archive as it is built.
2. The archive is a ZIP (ZIP64, so over 4 GB is fine) of one file per data set, named by the **phase** it must be loaded in (`p1-…` first): `p1-catalog_structure.csv`, `p3-customers.csv`… plus `README.txt` and a `manifest.json` with each file's row count, SHA-256 and template version, and whether it is complete or a part.
3. **CSV** is flat, one row per record, in the layout of the template (so an export can be edited and loaded back). **JSON** is one document per data set with typed values; with *nest children* on, accounts and services sit inside each customer, agents inside each dealer, rules, policies and assignments inside each commission plan, and the child files are left out of the top level.
4. **Memory does not depend on size.** Tables are read a page of 1,000 rows at a time with keyset paging (never `OFFSET`), written as they come, deflated as they go. Exporting 400,000 rows held under 25 MB of heap in a test.
5. **In parts.** *Rows per data set* limits each file; the job's summary records where each data set stopped and **Download the next part** continues from there with no overlap. Use it for tables too big for one request: the web app's API runs under a time limit on Vercel (60 s), which a large table can exceed; a self-hosted deployment has no such limit.
6. **Once.** An export can be downloaded once, by the person who started it; a second request is refused and a new export is a new job. Nothing is kept on a server afterwards.
7. **Progress.** The job's percent and row count move while it runs (Jobs tab; the estimate uses the planner's row count for large tables).

### Masking

By default sensitive fields are masked. A masked value is never the real one:

* **MASK** keeps the end so a person can recognise it: `****4556` (bank account numbers, the stored ID reference).
* **PSEUDONYM** is a keyed one-way code, `h:3fa9…`: the same value always gives the same code (records can still be matched) but it cannot be turned back, and it cannot be recomputed without the server's data key (ID-document hashes, eSIM activation codes).
* Login passwords, session data and API keys are **never** exported, masked or not. Meridian never stores a raw national ID: only a masked reference and a keyed hash.
* **Unmasked** export is for the super user only, needs a written reason (at least 10 characters), and writes the reason, the data sets and the person to the audit log. The archive says on its cover whether it is masked.
* Masked values are recognisable (`****…`, `h:…`) and can never be loaded back as if they were data.

## Templates

For every data set there is a CSV and a JSON template: the exact header, one line per column saying what it is, whether it is required, its type, the pattern or the values it must match and what it points at, an example row and a minimal row (as comments, so loading a template as it is adds nothing), what has to be loaded first, and a **version** that changes when a column does. The current versions are in the registry table; an import (next release) records the version it was made from.

## Limits

* Exports run in the web request that downloads them. Very large tables must be taken in parts on a serverless host.
* No object storage (S3 or GCS) is used for exports: the archive is streamed to the browser and not kept.
* Group and commission data sets are export only for now; the import release lists which data sets can be loaded.
