# Cases: classification, SLA, lifecycle and interactions

**Cases** (permissions `case:read` to look, `case:create` to open a case or log an interaction, `case:write` to work one; `settings:manage` for **Settings → Cases**, `integration:manage` for the field-service connection) is the support desk: every contact with a customer is an *interaction*, and a problem that needs following up is a *case*.

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
| Field service: connectors (`simulator`, `rest`), visits, the signed callback, TM Forum views | `packages/core/src/wfm/`, `workforce.ts`, `wfm-webhook.ts`, `tmf.ts` |
| More tables and columns | migration `0039_workforce_dispatch.sql` (`workforce_appointments`, `webhook_event_log`, dispatch columns on `cases`); `0038_case_sla_refunds_incidents.sql` (`case_refund_requests`, master and escalation columns on `cases`) |
| Screens | `apps/web/src/app/cases`, `apps/web/src/app/cases/board`, the Cases and Interactions sections of a customer, **Settings → Cases** (escalation numbers), **Integration → Field service** (the connection) |
| API | `/api/cases*`, `/api/interactions*`, `/api/settings/cases*`, `/api/integrations/field-service*` |

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

## Field service (technician visits)

**Integration → Field service and logistics → Field service (workforce management)** (permission `integration:manage`; API `GET` and `POST /api/integrations/field-service`, `POST /api/integrations/field-service/test`) connects a workforce-management (WFM) system through a connector, the same way charging systems are connected: `simulator` for trying the flow, and `rest`, a small REST/JSON contract (four `POST` calls: `/availability`, `/reservations`, `/jobs`, `/cancellations`) that Salesforce Field Service, Oracle Field Service Cloud or TOA sit behind through a thin adapter. The token comes from an environment variable named `MERIDIAN_WFM_…`, never the database; https only. A new system is one file in `packages/core/src/wfm/`.

**Booking.** An issue type says which skills (`FIBER_SPLICING`) and equipment (`ONT_UNIT`) its visit needs. On a case, the agent asks for free windows (`GET /api/cases/:id/slots`; a slot already full with Meridian's own bookings is not offered), **holds** one while on the call (the system reserves the slot, the skills and the equipment, for a few minutes; a hold nobody confirms is released by the sweep), and **confirms** it, which creates the job. One visit at a time per case; moving a visit books the new window first, so a failure leaves the old booking. Booking in one step is `POST /api/cases/:id/appointments`; `POST /api/cases/:id/dispatch` escalates a case to waiting-for-dispatch and, with `auto`, books the earliest slot. Optionally, when a fault case that normally needs a technician **breaches its SLA** the earliest slot is booked by itself (Settings → Cases → Visits and escalation, which also sets when supervisors are told about a late or unconfirmed visit; off by default).

**Installation times taken with the order.** *Integration → Field service and logistics → Field service → “Let the customer pick the installation time while the order is taken”* (off by default; needs the field-service system switched on and usable). When on, the new-order screen asks the system for free windows at the installation address (`GET /api/orders/installation-slots?address=…`, skills and equipment from the issue type `broadband.install.new`: `FIBER_SPLICING`, `ONT_UNIT`), and the agent or customer picks one instead of typing a preferred date (they can still choose to arrange it after the order). Placing the order (`installationSlotRef` on `POST /api/orders`) opens an **installation case** for the order (`cases.order_id`) and **holds** the window; if the window has gone the order is refused and another is chosen. Once the order is **paid** the hold becomes a job (re-booked on the same window if the hold ran out; if that fails the order goes ahead with no time, a note says why, and the case waits for an agent). An order that fails or is cancelled releases the window and resolves the case. The order's slot, its installation appointment and the installation part always show the visit's real window.

**Moving an installation.** An order's installation is moved like any visit: open its case (linked from the order) and choose *Move the visit*; the new window is booked before the old one is released, the customer is told, and the order follows. An agent working *any other* case for the same customer sees the customer's booked installations on the case and can move one from there (`GET /api/cases/:id/order-visits`, then `POST /api/appointments/:id/reschedule`). Manual date entry on the order is refused for a visit owned by the field-service system. The system's callbacks drive the order too: *on the way* / *on site* dispatch it (the installation can no longer be cancelled), *completed* completes the installation.

**The case follows the visit.** Confirming moves the case to *waiting for dispatch*; it becomes *dispatched* when the system has a technician on the job (at once if the system confirms synchronously, otherwise on the `ASSIGNED` callback). A completed visit resolves the case; the customer not being at home puts it in *waiting for the customer* (and pauses its SLA); a request for another time returns it to *waiting for dispatch*; a cancelled job returns it to the agent. The customer is told on **WhatsApp when they have used it in the last 90 days, otherwise SMS** (outbox `NOTIFY` with the channel), at booking, assignment, on the way, on site, resolved, not-at-home, rescheduling and cancellation, once each.

**The callback** is `POST /api/v1/cases/webhooks/wfm-callback`, with `X-WFM-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` made with the secret in the environment variable named in Settings (16 characters or more). A bad or stale (over 5 minutes) signature is refused with 401 and **nothing is stored**; with no secret set, or field service switched off, the URL does not exist. The body: `{ eventId, jobRef, type, occurredAt?, technician?: { ref, name, phone }, notes?, reason?, eta?, newWindow?: { start, end } }` with `type` one of `JOB_ACCEPTED`, `ASSIGNED`, `EN_ROUTE`, `ON_SITE`, `JOB_COMPLETED`, `CUSTOMER_NOT_AT_HOME`, `RE_SCHEDULING_REQUIRED`, `JOB_CANCELLED`. Every authenticated event is written to `webhook_event_log`, once per `eventId`:

| Answer | Meaning |
|---|---|
| 200 `APPLIED` | the visit and case were updated |
| 200 `IGNORED` | the visit already ended, or is already further along than the event says (late or repeated under another id) |
| 200 `DUPLICATE` | this `eventId` was handled |
| 404 `UNKNOWN_JOB` | no visit has that job number: the system should retry, as the booking may not have been recorded yet |
| 500 `FAILED` | the event could not be applied (recorded); delivering it again retries it |

A case an agent has already resolved is left alone (the visit is still recorded as completed).

**Waiting states.** A case waiting on a technician has a deadline: the booked window's end plus a grace (60 minutes by default), or, before a booking is confirmed, a few hours (4 by default). Past it, supervisors are told once (`DISPATCH_OVERDUE`). The Temporal watchdog waits through this and wakes at once on a `dispatchUpdated` signal; without Temporal the sweep does the same.

**Incidents.** A case resolved by a network incident has its booked visit cancelled with it, in the database at once and at the field-service system through the outbox (`WFM_CANCEL`). The same outbox carries a cancellation that could not be delivered the first time; `POST /api/cases/sla-sweep` (or `POST /api/cases/wfm-outbox`) delivers them.

## TM Forum Open APIs

Standard views of the same data, for a partner, a portal or an assurance tool, under `/api/tmf-api/…` (same sign-in and permissions as the rest of the API; a customer-scoped user sees only their own):

| Resource | Standard | Path |
|---|---|---|
| Trouble ticket (a customer's case) | TMF621 | `/troubleTicket/v4/troubleTicket` (list, get, create, patch) |
| Service problem (a network incident) | TMF656 | `/serviceProblemManagement/v4/serviceProblem` (list, get) |
| Party interaction (a customer touchpoint) | TMF683 | `/partyInteractionManagement/v4/partyInteraction` (list, create) |

(Customer interaction history is TMF683, and a network fault grouped across customers is a TMF656 service problem; TMF653 is service *test* management and is not offered.) These are profiles, not the whole of each specification: the attributes above, `offset`/`limit` paging (offset to 10,000) with `X-Total-Count`, `fields` selection, and TMF's status words (`submitted`, `inProgress`, `pending`, `resolved`, `closed`). A ticket's status can be patched to `inProgress`, `pending`, `resolved` (with a `statusChangeReason`) or `closed`; creating one needs a customer in `relatedParty`, a `name` and a `ticketType` (Fault, Billing, Porting, Enquiry). GraphQL is not offered.

## Not built here

Business-hours calendars, a technician-level schedule inside Meridian (the field-service system owns technicians and their calendars), real adapters for Salesforce Field Service, Oracle Field Service Cloud or TOA (the `rest` connector is the contract they sit behind), TM Forum event hubs and notifications, GraphQL, and per-queue routing rules beyond manual assignment, are not modelled; refund approval is by amount, not by reason code.
