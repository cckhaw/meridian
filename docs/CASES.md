# Cases: classification, SLA, lifecycle and interactions

**Cases** (permissions `case:read` to look, `case:create` to open a case or log an interaction, `case:write` to work one; `settings:manage` for **Settings → Cases**) is the support desk: every contact with a customer is an *interaction*, and a problem that needs following up is a *case*.

## What it is made of

| Piece | Where |
|---|---|
| The case engine: lifecycle rules, SLA clocks, assignment, timeline | `packages/core/src/cases.ts` |
| Classification tree, SLA matrix, closing rules | `packages/core/src/case-taxonomy.ts` |
| The interaction registry | `packages/core/src/interactions.ts` |
| Tables: `case_taxonomy`, `case_sla_config`, `cases` (extended), `customer_interactions`, `case_audit_log`, `customers.vip` | migration `0037_case_management.sql` |
| The SLA watchdog (timers, the steps, the sweep, the supervisors' board) | `packages/core/src/case-sla.ts` |
| Network incidents (master cases) | `packages/core/src/case-incidents.ts` |
| Refund approval by amount | `packages/core/src/case-refunds.ts` |
| The watchdog as a durable workflow | `services/order-service/src/workflows/case-sla.workflow.ts`, `activities/case-sla.ts`, `api/case-sla.controller.ts` |
| More tables and columns | migration `0038_case_sla_refunds_incidents.sql` (`case_refund_requests`, master and escalation columns on `cases`) |
| Screens | `apps/web/src/app/cases`, `apps/web/src/app/cases/board`, the Cases and Interactions sections of a customer, **Settings → Cases** |
| API | `/api/cases*`, `/api/interactions*`, `/api/settings/cases*` |

## Classification

Every case is filed under **Category → Sub-category → Issue type** (for example *Broadband / Fiber → No signal / down → LOS red light on*). The three levels are rows of one table that the operator edits in Settings; only an issue type carries behaviour: the kind of case it makes (`FIBER_ASSURANCE`, `BILLING_REFUND`, `MNP_PORT_OUT`, `GENERAL`), its usual severity, whether it normally needs a technician, and the technician skills and equipment to reserve (used by the dispatch part). An issue type that cases use is switched off rather than deleted.

## Service levels

The SLA matrix has a row for every **tier** (`VIP`, `ENTERPRISE`, `STANDARD`) and **severity** (`CRITICAL_OUTAGE`, `MAJOR_DEGRADATION`, `MINOR_INQUIRY`): a first-response time, a resolution time and the percentage of the resolution time at which a warning is raised (80 by default). A customer's tier is `VIP` when an administrator has marked them VIP, `ENTERPRISE` when their segment is a business segment (not an individual one), otherwise `STANDARD`. The times in force are copied onto the case when it opens (a later change to the matrix affects new cases only); a change of severity re-prices an open case from its opening time.

Clocks run in elapsed minutes (24×7): business-hours calendars are not modelled. The resolution clock **pauses while the case waits for the customer** and the waiting time is given back when the case moves on. The first response is the first outbound interaction on the case, or the first time the agent asks the customer for something. `slaView` is a pure function of the case row, so the screen, reports and the watchdog agree: `OK`, `WARNING` (at the warning percentage), `BREACHED`, `PAUSED`, and `MET` or `MISSED` once resolved.

## Lifecycle

`NEW → IN_PROGRESS → PENDING_CUSTOMER | PENDING_THIRD_PARTY | PENDING_DISPATCH → DISPATCHED → RESOLVED → CLOSED_VERIFIED | CLOSED_AUTO`, and `REOPENED` from a resolved or closed case.

| From | May go to |
|---|---|
| NEW | IN_PROGRESS |
| IN_PROGRESS | PENDING_CUSTOMER, PENDING_THIRD_PARTY, PENDING_DISPATCH, RESOLVED |
| PENDING_CUSTOMER | IN_PROGRESS, RESOLVED, CLOSED_AUTO |
| PENDING_THIRD_PARTY | IN_PROGRESS, RESOLVED |
| PENDING_DISPATCH | DISPATCHED, IN_PROGRESS |
| DISPATCHED | PENDING_DISPATCH, IN_PROGRESS, RESOLVED |
| RESOLVED | CLOSED_VERIFIED, CLOSED_AUTO, REOPENED |
| CLOSED_AUTO, CLOSED_VERIFIED | REOPENED |
| REOPENED | IN_PROGRESS |

Guards: resolving needs a written resolution; reopening needs a reason and, for a closed case, falls inside the reopen window (14 days by default); `CLOSED_AUTO` and `DISPATCHED` are made only by the system (the timer, and the field-service system) and a person cannot make them by hand; starting work assigns the case to the person if nobody has it; a change loses to a concurrent change instead of overwriting it. Every move, assignment, severity change, note and attached interaction is written to the case's audit trail (`case_audit_log`) and shown on the case as its history. The customer is told (an outbox `NOTIFY` message) when a case is resolved, reopened or waiting on them.

Port-out cases still follow the port-out: a confirmed port-out resolves them, a cancelled one closes them, both through the rules above.

## Interactions

Every touchpoint is logged on a channel (`CALL_CENTER`, `RETAIL_POS`, `WHATSAPP`, `WEB_SELF_SERVE`, `MOBILE_APP`, `EMAIL`, `IN_STORE`) with its direction. A telephony or chat system can send its own session id, and a resend is ignored (one row per channel and session). An interaction may be attached to a case afterwards (many interactions to one case, only the same customer's, each on one case at a time), or a case can be opened straight from one, which carries over the customer, service, subject and channel.

## The SLA watchdog

For each open case the watchdog does five things, each once and in order (`fireDueCaseTimers`, idempotent, so a retry never doubles a notice):

| When | What |
|---|---|
| The first response is overdue | supervisors are told |
| The resolution clock passes the warning percentage (80% by default) | supervisors are told |
| The resolution time passes | the case is **breached**, escalated one level and re-prioritised (at least High), supervisors are told |
| It is half as late again | second escalation (Urgent), supervisors are told |
| A resolved case reaches its closing time, or a case waiting for the customer reaches the response window | the case closes itself (`CLOSED_AUTO`) |

A paused case (waiting for the customer) cannot breach. Escalation re-prioritises the case but does not change its severity or re-price its SLA. Supervisor messages go to the outbox as `NOTIFY` with `to: SUPERVISORS` and the case's team.

Two ways to run it, both calling the same function: **the sweep** (`POST /api/cases/sla-sweep`, one indexed query for cases with something due; point a scheduler at it every minute or so, as with bill runs), and **one Temporal workflow per case** (`caseSlaWorkflow`: sleeps on a durable timer to the next deadline, wakes at once on a `caseChanged` signal, ends when the case closes; started with `POST /meridian-api/cases/:id/sla`). The workflow passes its own clock to each tick so a replay gives the same answers. The CRM does not call Temporal itself: a deployment that wants durable timers starts a watchdog when a case opens and signals it when the case's deadlines change. Without the signal a watchdog wakes at its old deadline and then follows the new one, and the sweep is the safety net.

The **supervisor board** (`/cases/board`, permission `case:supervise`) lists cases past their SLA or close to it, with their escalation level.

## Refund approval

On a billing-dispute case an agent asks for a refund against one of the customer's invoices. The **tiers** (Settings → Cases) say how much each group of roles may approve; the defaults are Agent (call center, customer service) up to 20.00, Team lead (new `team-lead` role) up to 100.00, and Finance manager (finance, billing operations) above that, with no limit. (Defaults are in minor units, so they read as 20.00 and 100.00 for a two-decimal currency.) The request needs the **lowest tier whose limit covers it**; someone in a tier can approve that tier's amounts and anything below.

* Within the asker's own tier: the invoice is credited at once.
* Above it: the request waits. Anyone at or above the required tier, **other than the person who asked**, can approve or reject (a reason is needed to reject); the asker can withdraw it. Approving claims the request and issues the credit note in **one transaction**, so two approvers cannot both pay it.
* The amount may not exceed what is left to credit on the invoice, counting other waiting requests.
* A case cannot be resolved while a refund on it is waiting.
* The supervisor board lists the requests a person may decide.

## Network incidents (master cases)

A **master incident** stands for a network fault at a postal node (a case's node is its customer's postcode, or one entered). It belongs to the network, not a customer, runs on the VIP row of the SLA matrix, and numbers as `INC-…`. Customer fault cases at the node are its **children**.

* A supervisor opens an incident for a node (it adopts the open fault cases there), attaches more cases, or removes one.
* **Suggestions**: nodes where several (5 by default) fault cases opened within an hour and are not on an incident. The operator can let the system open those incidents by itself (off by default).
* A new fault case at a node with an open incident joins it as it is created (switchable); each customer is told that the fault is known and being worked on.
* **Resolving the master resolves every open child** in one set-based statement: each child's audit trail shows the move from the state it was in (waiting for the customer, waiting for dispatch, …), its SLA pause is released, and each customer is told. Children already resolved or closed are left alone. Linking is set-based too, so an incident with thousands of cases is as quick as one with three.

## Not built here

Field dispatch (and cancelling the technician booking of children resolved with an incident), the work-force webhook and the TM Forum interfaces in part 3. Business-hours calendars, and per-queue routing rules beyond manual assignment, are not modelled; refund approval is by amount, not by reason code.
