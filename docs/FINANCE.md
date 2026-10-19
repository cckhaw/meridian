# Finance: sub-ledger, SAP journals and reconciliation

Everything that moves money becomes balanced double-entry lines in one immutable sub-ledger. Finance decides, in the portal, which SAP account each kind of line goes to; journals are exported to SAP as files (or by REST) and checked against the ledger and against what SAP says it posted.

## How it fits together

| Piece | Where |
|---|---|
| Sub-ledger tables (`gl_entries`, partitioned by month, immutable), event idempotency, dead letters | `packages/db/migrations/0026_sub_ledger_sap.sql` |
| Event engine (`SubLedgerEngine`: build, post, ingest, dead letters, partitions) | `packages/core/src/sub-ledger.ts` |
| Posting rules (chart-of-accounts mapping) | `packages/core/src/coa.ts` |
| SAP file building and transports (`SapExporter`) | `packages/core/src/sap-exporter.ts` |
| Batch runs, daily close, acknowledgement | `packages/core/src/journal-batches.ts` |
| Reconciliation and exception reports | `packages/core/src/reconciliation.ts` |
| Portal | Finance page: Ledger, SAP export, Reconciliation, Posting rules, SAP settings |

Billing, orders, lifecycle (final invoices, ETC) post straight into the same ledger and tag each line with a **revenue stream**. Other systems send events to `POST /api/ledger/events`.

## Events

`PAYMENT_SUCCESS`, `INVOICE_GENERATED`, `ADJUSTMENT_POSTED` (CREDIT or DEBIT), `ETC_CHARGED`. Each has an `eventId`, `occurredAt` (ISO), `currency` (must be the regional currency), integer minor-unit amounts, and for invoices and adjustments `lines: [{ stream, netMinor }]` plus `taxMinor`.

* The same `eventId` and content posts once; the same id with different content is rejected.
* A message that cannot be posted (bad JSON, wrong currency, negative amount) goes to the dead-letter list (`GET /api/ledger/dead-letters`, retry with `POST /api/ledger/dead-letters/:id/retry`).
* The posting date is `occurredAt` on the calendar of the regional time zone.

Revenue streams: `SUBSCRIPTION`, `USAGE`, `DEVICE_INSTALMENT`, `THIRD_PARTY` (partner content such as Netflix), `ETC`, `GOODS`, `ONE_TIME`.

## Immutability

A database trigger refuses `DELETE` and any `UPDATE` of a posted line except stamping `exported_batch_id` once (NULL to a batch). Corrections are new journals (credit note, debit adjustment).

## Posting rules

Finance → Posting rules maps a ledger line (account, stream, event, source) to a SAP G/L account, cost centre, profit centre and tax code. The most specific rule wins (account 8, stream 4, event 2, source 1); between equals the lower priority number wins; inactive and out-of-date rules are ignored. "Try a line" previews the result. Lines with no rule stop the export: the run is recorded as FAILED, nothing is exported, a reconciliation exception is raised, and the page lists the uncovered lines.

**Limits** (one definition, `COA_LIMITS` in `packages/core/src/coa.ts`, sent to the screen with `GET /api/finance/meta` as `limits`; the screen's inputs read it): name 2 to 80 characters; priority a whole number 1 to 9999 (blank = 100); ledger account, SAP G/L account, cost centre and profit centre up to 10 characters, tax code up to 4, event up to 40, source up to 20; note up to 200. Anything wrong is refused with a message; nothing is cut silently. The only things done to a value that is accepted are listed in `adjustments` in the save result and shown on the screen after saving: spaces at the ends removed, codes put in capitals (`ab-1` is saved as `AB-1`), and a note longer than 200 characters shortened to its first 200 (the screen stops typing at 200 and counts, so this only happens to API callers). The status is `ACTIVE` or `INACTIVE`; anything else is refused.

The seeded rules use placeholder SAP codes. Replace them with the customer's chart of accounts before the first real export.

## Export to SAP

Finance → SAP settings: company code, document type, ledger group, format (`FLAT`, `IDOC`, `JSON`, `CSV`), documents (one summary per posting day, or one per journal), delivery (`MANUAL` download, `REST`), automatic daily close, real-time export.

* Run types: `MANUAL` (Finance), `SCHEDULED` (the daily close, which exports everything posted up to the end of yesterday; runs from the daily job when switched on, or on demand with "Run daily close"), `REALTIME` (one event at once).
* Every run keeps the exact file (`journal_batch_files`) with its SHA-256, so a download or a resend is always the file that was produced.
* REST delivery posts the file with an `idempotency-key` of the batch id; the bearer token comes from `MERIDIAN_SAP_TOKEN` and is never stored. A failed send can be repeated.
* SFTP and RFC are not implemented in the CRM: choosing them needs an integration connector deployed with the SAP landscape.

## Reconciliation

After every run the batch is checked: ledger lines stamped with the batch, the batch record, the totals re-read from the stored file, per-account totals, the checksum, and SAP's acknowledgement once recorded. Finance → Reconciliation also checks a whole period (unbalanced journals, unexported lines, unmapped accounts, batches against the ledger, and the AR and cash control accounts). Any error is a `RECONCILIATION_MISMATCH`: it is shown on the report and written to `lifecycle_outbox` (kind `EVENT`, topic `meridian.finance.events`) for the message bus. A delivered batch with no acknowledgement after 48 hours is a warning.

## Permissions

`finance:read` (see everything), `finance:export` (run, download, resend, acknowledge, reconcile), `finance:configure` (posting rules, SAP settings), `ledger:ingest` (send events; admin only by default). See `ROLES.md`.

## Known limits

* Ingestion is an HTTP endpoint (and the outbox), not a Kafka consumer; a consumer can call `SubLedgerEngine.ingest` for each message.
* The IDoc, flat file and JSON layouts follow common FIDCCP02 / BAPI_ACCDOC_POST shapes. Validate them against the customer's SAP definitions before go-live.
* The REST transport has been tested against a stub, not a real SAP gateway.
* The ledger is kept in one currency (the regional currency).
