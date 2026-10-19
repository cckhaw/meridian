# Data migration: export, templates and import

**Back office → Data migration** (permissions `migration:export` and `migration:import`; the Administrator role has both) backs up and moves the platform's data. This page describes what is built.

## What the engine is made of

| Piece | Where |
|---|---|
| The description of every record type: its fields (type, required, pattern, values, example, sensitivity), its phase, what it depends on, how to read it a page at a time | `packages/core/src/migration/entities.ts` |
| Streaming export (a ZIP built while it downloads), masking, a streaming ZIP64 writer | `migration/export.ts`, `mask.ts`, `zip.ts`, `format.ts` |
| Templates (CSV and JSON), and the registry of their versions | `migration/templates.ts`, table `data_templates` |
| Jobs (who exported or imported what, progress, problems) | `migration/jobs.ts`, tables `migration_jobs`, `migration_job_items` (migration `0031`) |
| Import: uploads (chunked or object store), the CSV reader, cleaning rows, one importer per data set, the job runner | `migration/uploads.ts`, `s3.ts`, `csvstream.ts`, `coerce.ts`, `importers.ts`, `runner.ts`, tables `migration_uploads`, `migration_blobs`, `migration_refs`, `migration_keys` (migration `0032`) |
| Screens and API | `apps/web/src/app/admin/migration`, `/api/migration/*` |

Everything is driven by the entity descriptions, so a new record type is one definition, not a new feature.

## The data sets

There are 106 data sets in 10 domains (16 of them can be loaded). Each is one definition in `migration/entities.ts` (the first engine's sets) or `migration/entities-modules.ts` (the sets of the later modules, written as one line per column).

| Domain | Data sets |
|---|---|
| **Product** | Catalog structure, offers, offer line items, offer types, offer types that cannot be ordered together, fulfilment options, service types, VIP number tiers (slabs), bundle discount rules, terms: cancellation and return rules, terms: store terms and privacy links |
| **Customer** | Customer segments, customers, accounts, service groups and their members, customer segment changes |
| **Operations** | Stores, dealers, agents, commission plans, rules (with volume slabs), claw-back policies, plan assignments, commission earnings (ledger), settlements, payout batches and closed periods, warehouses, stock on hand, stock movements, stock transfers (lines and SIMs), store cash-drawer closings |
| **Subscriber and financial** | Services, SIM inventory (ICCID), IMSI pool, number inventory (MSISDN), donor operators, number port-in requests, scheduled plan changes, voluntary suspensions, service and number lifecycle history, sub-ledger balances (trial balance), account balances (receivables), active dunning cases |
| **Orders and sales** | Orders (with lines and fulfilment groups), payments, payment intents, order state history, sign-up applications (store-front and assisted), credit checks (device financing) |
| **Billing, dunning and finance** | Bill cycles, bill templates and versions, bill runs, invoices and lines, late-fee configurations, dunning rules and steps, early-termination rules, payment arrangements, collection placements, recurring service charges, posting rules (chart-of-accounts mapping), journal batches, reconciliation reports and exceptions |
| **Cases and field service** | Case taxonomy, SLA matrix, cases, case history, refund requests, customer interactions, field-service appointments (work orders), installation appointments |
| **Documents and KYC** | Agreement templates and versions, the document vault records, signatures, the document access log, KYC cases |
| **Fibre coverage** | Providers, cabinets, distribution points, ports, coverage areas, waiting list, expansion requests |
| **Security, integration and platform** | Staff users, fraud blacklist and alerts, API clients (OAuth2), API keys, webhook subscriptions, integration endpoints, rate-limit rules, event topic mappings, all settings groups, audit log |

Enterprise departments and IoT hierarchies are customers: a department has a parent customer, and an IoT hierarchy is the IoT enterprise segment with its departments. Both are in the customers file (`parent_customer_id`, `segment`), and nested under their parents in JSON.

**Nesting in JSON.** Orders carry their lines and fulfilment groups; invoices their lines; dunning rules their steps; bill templates and agreement templates their versions; stock transfers their lines; fibre providers their cabinets and each cabinet its distribution points; plus the older nests (customers → accounts → services, dealers → agents, commission plans → rules, policies and assignments, service groups → members).

### What is never in a file

A column that holds a secret is not in any data set, so no mode (not even an unmasked export) can write it: password hashes, MFA secrets and recovery codes, sessions and reset tokens, OAuth client secrets, API-key hashes, webhook signing secrets, integration endpoint credentials, fibre adapter secrets, application access tokens, the encrypted ID number of a KYC case, the contents of stored documents and KYC images, payout files (they hold bank details) and profile pictures. Inside JSON settings (the settings groups, integration endpoint settings, webhook filters) any key that looks like a secret, password, token, credential or API key is replaced with `(not exported)`. After loading into another environment, re-issue client secrets and set integration credentials again.

Personal data that an export keeps is masked in a masked export: applicant details on applications, IP addresses and GPS tags on signatures and the access log, the holder's ID number on port-in requests, fibre waiting-list contacts, document names, fraud-alert identifiers, and (as keyed codes) the ID hash on credit checks and KYC cases and the blacklist values.

### Identity verification (KYC) when moving data

* **Customers** carry `kyc_status` and `kyc_verified_at`. Orders are only sold to a customer whose status is `VERIFIED`, so customers loaded from another system need `VERIFIED` in the file (or go through the review queue afterwards).
* **KYC cases** are export only. The export has the details checked, the flags and the checks (including the connected ID-check service's or MyDigital ID's verdict and its reasons), who decided and why. It never has the ID number (only its masked form and a keyed code) or the photographs.
* **The ID-check settings** are in the integration endpoints data set (`KYC_OCR` and `KYC_MYDIGITALID` in the `identity` group) and in the settings groups (which methods the store-front offers). Secrets and client credentials are not exported, so after loading into another environment enter them again under **Integration → Identity**.
* In-flight MyDigital ID sign-ins (`kyc_provider_sessions`) are short-lived, hold encrypted form data and are deliberately left out.

### Documents and the vault

The export carries the **records** of the vault (kind, owner, name, size, SHA-256, where the file is stored, status, retention, the template version it came from), the signature records with their content seal, and the access log. It does not carry the files. To move the files, copy the document bucket (the `storage_key` of each record says where its file is) or, for files held in the database, take a database backup; keep the document data key (`MERIDIAN_DATA_KEY`) the same or the files cannot be opened. The agreement templates and every version of their HTML are in the export.

### Keeping the module up to date

`migration/modules.spec.ts` fails the build when the schema moves ahead of the migration module:

* every database table must be described by a data set, or named in the spec's `LEFT_OUT` list with the reason it is not exported (queues, caches, sessions, scratch data, binary content);
* every column of a described table must be in its data set, or named in `NOT_IN_FILE` with the reason (a secret, a file content, a value rebuilt from other records);
* every reference must point at a data set, every dependency must load in an earlier or the same phase, and no export may carry a planted secret.

So adding a table or column in a migration means adding it to the data set (or giving the reason) in the same change. A template's version changes when its columns do, and an import records the version it was made from.

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

For every data set there is a CSV and a JSON template: the exact header, one line per column saying what it is, whether it is required, its type, the pattern or the values it must match and what it points at, an example row and a minimal row (as comments, so loading a template as it is adds nothing), what has to be loaded first, and a **version** that changes when a column does. The current versions are in the registry table; an import records the version the file was made from, warns when it is an older one, and refuses a file made from another data set's template.

## Importing

**Import tab.** Pick the data set, pick the file, choose whether rows with problems are skipped, and **Upload and check**. Nothing is changed until you press **Load**.

### Loadable data sets and the phases

| Phase | Data sets that can be loaded | Notes |
|---|---|---|
| 1 Catalog, configuration and inventory pools | Catalog structure (including scheduled nodes), offers, offer line items, SIMs (ICCID), IMSIs, numbers (MSISDN) | Structure, offers and line items use the same code as their screens. Offers carry every newer term (validity, charging-plan code, suspension terms, group-plan terms, characteristics: see [CATALOG.md](CATALOG.md)). Numbers are classified into VIP tiers with the live patterns unless the file gives a tier. Once any number is in the inventory, new mobile orders draw their number from it, so load the whole pool (or none) before taking orders. |
| 2 Stores, dealers, agents, warehouses, stock and users | Stores, dealers, agents, warehouses, stock on hand | Same loaders as the Dealers, Stores and Warehouses screens (give every row an id to make a re-run safe: an empty id adds a new record each time; for a warehouse an id that exists is skipped and a name already used by another warehouse is a problem). **Stock on hand** is an opening count: each row sets the count at that place and stock code, through the stock screen's own loader, so the movement ledger records it and a second load leaves the same numbers. |
| 3 Customers and accounts | Customers (including enterprise departments and IoT hierarchies; VIP and credit-risk flags), accounts | `id` is your key for the record; later files point at it. A parent is listed before its departments. Individuals are unique by ID document. |
| 4 Services | Services (with the number, SIM and IMSI they use, the device deal, a suspension's kind, start and end date, the ported-in number status, the VIP early-termination multiplier, the last SIM swap and the parent service of a value-added service) | The number, SIM and IMSI inventory rows are marked in use, and the number is registered platform-wide. A value-added service names the mobile service it belongs to in `parent_service_id`; list the parent first. No charging-system or commission side effects: the old system already provisioned the service. |
| 5 Balances and dunning | Account balances, active dunning cases | See below. |

Everything else is **export only**: the settings-like sets (offer types, offer-type conflicts, fulfilment options, service types, VIP slabs, cancellation rules, terms, segments, commission configuration, dunning, billing, case, document, fibre and integration configuration) are small, change often through their own screens and are better set up there, and the transaction records (orders, invoices, payments, cases, appointments, documents, ledgers and histories) are a backup and audit trail, not something to fabricate on another system: a legacy system's customers, accounts, services and opening balances come in through the sets above, and its history stays in its own archive. Fibre infrastructure has its own loader in the Fibre coverage app (`docs/FIBER_COVERAGE.md`).

**Order is enforced.** A job for a data set waits (status *Waiting*, "Waiting for Customers to finish") while any job it depends on, or any earlier phase, is still checking, waiting to be loaded or loading. A file also fails its check if it points at a key that has not been loaded. The archive from an export names its files by phase.

### The pipeline

1. **Upload.** The browser sends the file in 2 MiB pieces (base64 in JSON, so each request fits a serverless limit of about 4.5 MB); pieces are kept in `migration_blobs` until the job has read them. Up to 256 MB by default (`MERIDIAN_MIGRATION_DB_MAX_MB`). With an object store configured the browser instead sends the file straight to the bucket with a **pre-signed URL**, up to 5 GB, and nothing large passes through the app.
2. **Formats.** CSV and NDJSON are read as they are. A **JSON** document and an **Excel** (`.xlsx`, first sheet) file are turned into rows when the upload completes (up to 128 MB; use CSV or NDJSON beyond that). A nested JSON export (customers with accounts and services) is split into one file per data set, which are then loaded in order. Write dates in a spreadsheet as text (`2026-01-31`): Excel's own date cells are numbers.
3. **Schema validation.** The header is matched to the template (unknown or missing columns fail the file at once, before any row); each cell is checked for type, required, length, pattern and allowed values. Masked values (`****…`, `h:…`) are refused. A cell an export guarded with a leading `'` is restored.
4. **Reference check (dry run).** The whole file is read and every row is checked against the database exactly as the load will (keys exist, no duplicates in the file or already there, ID document unique, numbers free, offers in the catalog, currency matches, and so on) **without writing anything**. The result is the *Checked* state: rows ready, rows with problems, rows already loaded.
5. **Row-level report.** Every problem has its line, field, a code and a plain message, shown on the page and downloadable as CSV (kept up to 5,000 entries per job; the counts are always complete).
6. **Load.** In batches (500 rows for customers, accounts, services and balances; 2,000 for number pools), each batch one transaction, with bulk statements (`INSERT … SELECT FROM unnest(…)`), not a statement per row.
7. **Skip or stop.** *Skip rows with problems off* (default): the load is offered only if the check found none. *On*: good rows load, bad rows are listed, and the job stops, and rolls back where it can, if more than the chosen percentage of rows have problems (checked before loading, and again while loading in case something changed).

### Jobs, slices and progress

A load is a **job** (`MigrationJob` is `migration_jobs`, the row-level log is `migration_job_items`, the template registry is `data_templates`) with status Waiting, Checking, Checked, Loading, Done, Failed, Cancelled, Taking out, Rolled back. Work is done in **slices**: `POST /api/migration/jobs/:id/run` works for about 20 seconds and returns the state. The Import tab calls it back to back while the page is open; a scheduler can call `POST /api/migration/run` (permission `billing:run`) so loads continue with nobody watching. The job saves its place (a byte offset at a row boundary) in the same transaction as the batch it just wrote, so a slice that dies, a second server, or a retry never repeats or skips a row. Only one request works on a job at a time (a lease). Reading is streaming: the file is read in ranges and parsed a batch at a time, so memory does not depend on the size of the file.

This is the queue-and-worker the specification describes, built on the database already in use rather than Redis and BullMQ, so a serverless deployment needs nothing more. A deployment that wants a separate worker can run the same function in a loop (`runDueMigrationJobs`).

### Keys, repeats and rollback

* Every record a load creates is remembered in `migration_refs` against the key it had in the old system. That is how accounts find their customer, and why **loading the same file twice does nothing**: keys already loaded are skipped and counted as such.
* **Rollback** (button on the job, or automatic when the error threshold is breached while loading) takes out what the job created, in slices, for customers, accounts, services, number pools, SIM and IMSI pools, opening balances, dunning cases and warehouses (a warehouse that has since received stock or been part of a transfer stays, with a message). It stops with a message if something now depends on the records (an account that has since got services or invoices). Catalog structure, offers, line items, stores, dealers, agents and stock counts are loaded by the screens' own code and **cannot be taken out automatically** (a stock count has no "before" to go back to: correct it with a new count); if a load of those is stopped, what was loaded stays and the file can be loaded again.
* Cancelling a job leaves rows already loaded in place; roll back to remove them.

### Customers, accounts, services

* Customers: segment must exist and be active; market must be set up; `id_document` becomes a masked reference and a keyed hash (Meridian never stores the raw number); a restore uses `id_document_hash`. The hierarchy path is built from the parent's.
* Accounts: `bill_cycle_day` is 1-28, `DAILY`, or empty for the default cycle in Settings; currency defaults to the market's.
* Services: the status, contract, SIM, IMSI and VIP tier are kept as given. A suspended service is recorded as an administrative suspension. Terminated services are loaded for history; they do not take the number. If a number appears on more than one service (a terminated holder and the current one), keep only the current one.

### Opening balances and dunning

* An **opening balance** becomes one invoice of kind `OPENING` per account, so it is billed against, collected and dunned like any other. The ledger gets **debit receivables (1200), credit migration clearing (3900)** so receivables still equal the open invoices and the reconciliation passes. **Finance must map account 3900 to the clearing account used for the cut-over** (Finance → Posting rules, and the chart of accounts in SAP) before the first journal export.
* **Active dunning cases** record the account's stage and an active dunning run with the anchor due date. They do not bar services or send notices: bars already in force on the old network come in with the services file (`bar_level`).

### Object storage (optional)

Set these on the server (Vercel project settings or the host's environment) to use an S3-compatible bucket (Amazon S3, Google Cloud Storage's S3 interface with HMAC keys, Cloudflare R2, MinIO):

| Variable | Meaning |
|---|---|
| `MERIDIAN_MIGRATION_S3_BUCKET` | Bucket name |
| `MERIDIAN_MIGRATION_S3_REGION` | Region (default `us-east-1`) |
| `MERIDIAN_MIGRATION_S3_ACCESS_KEY_ID`, `MERIDIAN_MIGRATION_S3_SECRET_ACCESS_KEY` | Credentials able to PUT, GET, HEAD and DELETE under the prefix |
| `MERIDIAN_MIGRATION_S3_ENDPOINT` | Only for a non-Amazon service, for example `https://storage.googleapis.com` or a MinIO URL (path-style) |
| `MERIDIAN_MIGRATION_S3_PREFIX` | Folder for uploads (default `meridian-migration/`) |

The bucket needs a CORS rule allowing `PUT` from the CRM's origin. In this mode files must be CSV or NDJSON (the app does not download a multi-gigabyte file to convert it). Signing is AWS Signature V4, checked against the AWS documentation's test vector. The bucket should have a lifecycle rule to delete old uploads; the app does not delete them.

## Limits

* Exports run in the web request that downloads them. Very large tables must be taken in parts on a serverless host. No object storage is used for exports: the archive is streamed to the browser and not kept.
* Uploads kept in the database (the default) are limited to 256 MB; larger files need the object store. Uploaded pieces stay in the database until the upload is discarded: clear old ones with `DELETE FROM migration_uploads WHERE created_at < now() - interval '30 days'`.
* Stores, dealers, agents, offers, line items, stock counts and catalog structure load with the screens' own code: they are loaded in batches (hundreds to a thousand rows), not bulk statements, and their batch is not in the same transaction as the job's progress, so a crash between the two could repeat a batch (rows with an id update; rows without an id would be added again).
* A parent listed after its child in a file of stores, dealers or catalog structure larger than one batch fails the check; keep parents first.
* Group, commission, billing, case, document, fibre, integration and the other settings-like and transactional data sets are export only (see the table above).
* The size of the full archive is the size of the database: take large tables (orders, invoices, order lines, the audit log, stock movements) in parts on a serverless host.
