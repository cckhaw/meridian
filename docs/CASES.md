# Cases: classification, SLA, lifecycle and interactions

**Cases** (permissions `case:read` to look, `case:create` to open a case or log an interaction, `case:write` to work one; `settings:manage` for **Settings → Cases**) is the support desk: every contact with a customer is an *interaction*, and a problem that needs following up is a *case*.

## What it is made of

| Piece | Where |
|---|---|
| The case engine: lifecycle rules, SLA clocks, assignment, timeline | `packages/core/src/cases.ts` |
| Classification tree, SLA matrix, closing rules | `packages/core/src/case-taxonomy.ts` |
| The interaction registry | `packages/core/src/interactions.ts` |
| Tables: `case_taxonomy`, `case_sla_config`, `cases` (extended), `customer_interactions`, `case_audit_log`, `customers.vip` | migration `0037_case_management.sql` |
| Screens | `apps/web/src/app/cases`, the Cases and Interactions sections of a customer, **Settings → Cases** |
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

## Not built here

The SLA watchdog, escalation, refund approvals and master incidents are in part 2; field dispatch, the work-force webhook and the TM Forum interfaces in part 3. Business-hours calendars, and per-queue routing rules beyond manual assignment, are not modelled.
