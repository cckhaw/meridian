# Billing: bill runs, governance, simulation and print output

**Billing → Bill runs** (permissions `billing:read` to look, `billing:run` to prepare a run, `billing:approve` to approve it, `settings:manage` to change the rules) bills the 28 monthly cycles, the daily-cycle accounts, or chosen accounts, in four steps that cannot be skipped. This page describes what is built; the template and print-house engine is added by the next release.

## What it is made of

| Piece | Where |
|---|---|
| Cycle bill (what an account is charged for a period), split into a read-only draft and the commit | `packages/core/src/billing.ts` (`draftCycleBill`, `priceDraft`, `billAccount`) |
| The governed run: mock, review, exclusions, approval, production, in resumable slices | `packages/core/src/bill-runs.ts` |
| Tables: `bill_cycle_configs` (the 28 cycles), `bill_runs`, `bill_run_items`, `bill_run_exclusions`, `invoices.bill_run_id` | migration `0034_bill_runs.sql` |
| The same four stages as a durable Temporal workflow with deadlines and signals | `services/order-service/src/workflows/bill-run-governance.workflow.ts` |
| The billing simulator: forecasts, termination quotes, plan-change previews, saved simulations | `packages/core/src/billing-simulation.ts`, tables `simulation_runs`, `simulation_ledger` (migration `0035`) |
| Screens and API | `apps/web/src/app/billing/runs`, `apps/web/src/app/billing/simulate`, `/api/billing/runs*`, `/api/billing/cycles`, `/api/billing/exclusions`, `/api/billing/simulate/*`, `/api/billing/simulations*` |

## The four stages

1. **Mock.** Every account of the cycle is priced exactly as it will be billed (same code), without writing an invoice, a ledger line, a notification, or using up an instalment. The run keeps one row per account: its totals, last month's total for comparison, and any flags. The summary shows revenue by stream, tax by market, and counts by flag.
2. **Review.** The page lists accounts with filters (any flag, excluded, no bill, failed) and a search; **View bill** shows one account's lines and its recent bills. Flags: **spike** (a bill 300% or more above the last one; the percentage is a setting), **drop** (70% or more below), **zero** (the account has active services but would get no bill), **large** (at or above an amount; off by default), **no earlier bill** (information), **already billed**, and, after production, **differs from the mock**.
3. **Exclusions and selective runs.** *Exclude* keeps one account, or an enterprise customer **and every department below it** (found through the customer hierarchy), out of this run, with a reason. A **standing exclusion** applies to every run until lifted or until its end date (a legal dispute, a fraud case) and takes effect at once on runs under review. Lifting an exclusion sends what it held back to be priced again. A **selective run** bills only chosen accounts (up to 10,000): the same four steps, nobody else is touched. Accounts that fail in production are billed again on their own (**Bill the failed accounts again**), also without a sweep of the cycle.
4. **Approve and bill.** Approving starts production: invoices are issued, journals posted to the sub-ledger (so they leave in the next SAP batch), a notification is queued for each customer (`lifecycle_outbox`, instruction `INVOICE_ISSUED`) and one event for the run (`BILL_RUN_COMPLETED`, topic `meridian.billing.events`). Before it bills, exclusions are applied once more, so one added after the mock still holds, and an account that is no longer active is skipped. A bill that comes to a different amount than the mock is flagged.

### Who may do what

* **Billing Operations** (`billing:run`): start a run, review, exclude and put back, submit, re-run the mock, cancel, retry failed accounts. Cannot approve.
* **Finance and Revenue Assurance** (`billing:approve`): approve (or send back) and start production. The Administrator role has neither: it manages users and the catalog, not money.
* **Super user**: the rules below, and the cycles.
* **Dual control** (a setting, overridable per cycle): the run must be *submitted*, and the person who approves cannot be the person who asked for it or who submitted it. Without it, one person with `billing:approve` approves a mock directly.
* An approval is **refused when the mock is older** than the limit (24 hours by default), because the data may have changed: run the mock again so what is billed is what was reviewed. A run still has to have every account priced and something to bill.
* **No bypass.** While governance is on (the default) the plain "bill this date" call (`POST /api/billing/run`) is refused. A super user can switch governance off in *Cycles and rules*; leave it on in production.

### States

`MOCK_RUNNING → MOCK_COMPLETED → (PENDING_APPROVAL) → APPROVED → PRODUCTION_RUNNING → COMPLETED`, and `CANCELLED` or `FAILED`. A run sent back goes from `PENDING_APPROVAL` to `MOCK_COMPLETED`; excluding or putting back accounts, or running the mock again, returns a run to `MOCK_RUNNING` until the changed accounts are priced. One run per cycle and bill date is allowed at a time, and a completed one cannot be repeated (billing is also idempotent per account and period).

## Slices, scale and progress

A run is a list of items, one per account, created in one statement when the run starts (`INSERT … SELECT` from the accounts of the cycle, which the `(bill_cycle_day, id)` index serves in id order). Both passes walk it in account order in **slices**: `POST /api/billing/runs/:id/work` works for about 20 seconds (100 accounts per mock batch, 25 per production batch, each production account in its own transaction so one bad account cannot stop the others) and says where it is. The page calls it while open; a scheduler can call `POST /api/billing/run-due` so a large run goes on with nobody watching. Only one caller works on a run at a time (a lease), and a slice that dies is picked up by the next.

## The workflow

`billRunGovernanceWorkflow` runs the same stages as a Temporal workflow for a deployment that wants durable deadlines: it starts the mock, drives the CRM's slices, waits for review (exclusions and inclusions arrive as signals and are applied as they come), waits for approval (an unreviewed mock or an unapproved submission **times out and is cancelled**, 72 hours by default), never starts production without an approval signal, and stays for a retry window after production to bill failed accounts. The CRM enforces the rules (a second person, a fresh mock); a refused approval is recorded in the workflow's status and it keeps waiting for a valid one. Signals: `exclude`, `include`, `submit`, `approve`, `reject`, `cancel`, `retryFailed`; query: `governanceStatus`. The activities are an interface (`BillRunActivities`) with the API calls each one makes documented; the shipped worker uses an in-memory stand-in, as for dunning. The CRM works fully without the workflow.

## Settings and the 28 cycles

*Cycles and rules* (super user): governance on/off, dual control, the spike and drop percentages, the large-bill limit, how old a mock may be, and per cycle: on/off and its own second-approver rule. A cycle that is off cannot be run.

## The billing simulator

**Billing → Billing simulator** (permission `billing:simulate`: Billing Operations, Call Center, Customer Service, Finance and Revenue Assurance) answers forward-looking questions with the **same code that bills and ends services**, and changes nothing: no invoice, ledger line, instalment, service or account is touched (a test checks this). An answer can be **saved** (a quote an agent gave, a forecast Finance keeps) with who ran it and when; saved answers are scratch data that nothing else reads (`purgeSimulations` removes those older than 90 days). There is a shortcut on a service in the customer view.

* **Forecast bills** (up to 60 months, or 60 days for a daily-cycle account). Starting at the account's next unbilled bill date, each bill is built by the real cycle-bill code as if the earlier bills had been issued: the plans, the device instalments (an instalment with fewer bills left than the month being forecast has finished), tax, and the **device balance still owed after each bill**, falling to nothing at the **final instalment**, which is called out with the bill that finishes it. For each bill it also shows **what it would cost to end every contract on that date** (the early-termination charge by the contract's own rule, so it falls as the contract runs down and is nothing at the end). The first forecast bill is exactly the bill the next run would issue (tested to the cent). A forecast holds today's prices, contracts and charges: price changes, new services, plan changes and usage are not known.
* **Ending a service.** The amount the customer would owe: the early-termination charge (with the free window, VIP multiplier, segment exemption, and a waiver or a percentage with its reason), the recurring charge not yet billed up to the end date, usage not yet billed (entered by the agent: the charging system's figure is not read), tax, and, optionally, the deposit applied and refunded. `payNowMinor` is the figure to quote. It is the same function the termination uses (`closingStatement`), and a test ends the service for real and checks the amounts match to the cent. Quoting a **waived or reduced** charge needs the right to end services (`service:terminate`), because it is the same decision. **Note:** ending a service cancels the device instalments still to come, as the termination always has (the early-termination charge is the only charge); the preview states this with the amount so nobody is surprised, and Finance may want to decide whether the remaining balance should be collected.
* **Plan change.** For a service changing plan on a date: the statement that covers the date (the next bill date after it, in arrears) shows the old plan pro-rated up to the date and the new plan from it, compared with leaving things as they are, and the statement after it. It warns about a downgrade, a contract that would restart, and the early-termination exposure on the current contract. It is a preview: changing a plan in the live system is not built by this release.

Simulation answers are stored one row per bill in `simulation_ledger`, partitioned by the account's bill cycle day (28 partitions, daily-cycle accounts in `00`), so a cycle's simulations live and can be dropped together.

## Not built, and design notes

* **Prisma, NestJS microservices, Kafka, BullMQ.** The CRM keeps its schema in SQL migrations and runs on the database it already has; the queue and worker are the slice driver above. Kafka is represented, as elsewhere, by the outbox.
* **Partitioning by bill cycle day.** `accounts`, `invoices` and the run items are not re-partitioned: the shard partitioning stays, and the cycle is served by the `(bill_cycle_day, id)` index (a 1,000-account page took 5 ms on 4 million accounts in the scale review, see [SCALE.md](SCALE.md)). Re-partitioning accounts by cycle day would break the shard routing.
* **Cycles of other lengths** than a day of the month are not modelled.
