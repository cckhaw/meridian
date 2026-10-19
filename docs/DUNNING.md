# Dunning and collections

Chasing overdue accounts is driven by **dunning rules**. A rule says *who* it applies to and gives a *ladder* of steps: what happens on which day past due, or when the overdue balance reaches an amount. The same rules run in the daily job (`POST /api/lifecycle/run`, `runDunning`) and per account.

The older single ladder in **Settings → Lifecycle** ([LIFECYCLE.md](LIFECYCLE.md#c-dunning-ladder)) still works. An account follows it when no active rule fits, and an account already part-way down it finishes it. Nothing changes until a rule is switched on.

## What is built

| Area | Where |
|---|---|
| Rules, steps, late fee configurations, validation, matching | `packages/core/src/dunning-rules.ts`; tables `dunning_rules`, `dunning_rule_steps`, `late_fee_configs` (migration `0040`) |
| The engine: due steps, exclusions, holds, late fees, case tasks, bars, termination, partial payments | `packages/core/src/dunning-engine.ts`; tables `dunning_runs` (with the rule's ladder frozen on it), `dunning_steps` |
| Message templates | `packages/core/src/dunning-templates.ts` |
| QR payment codes (EMVCo merchant-presented) | `packages/core/src/emv-qr.ts` |
| Payment arrangements, agency placements, agency file | `packages/core/src/collections.ts`; tables `payment_arrangements`, `collection_placements` |
| Southeast Asia starter rules | `packages/core/src/seed-dunning-rules.ts` |
| Limits (one definition, shared by the screen and the server) | `packages/core/src/dunning-limits.ts`: `DUNNING_LIMITS` (fixed), `DUNNING_LIMIT_DEFAULTS` / `DUNNING_LIMIT_BOUNDS` and the settings key `dunningLimits` (configurable) |
| Settings page | `apps/web/src/app/admin/settings/dunning.tsx` |
| Temporal workflow | `services/order-service/src/workflows/dunning-ladder.workflow.ts`, `activities/dunning-ladder.ts`, `api/dunning-ladder.controller.ts` |
| API | `/api/settings/dunning-rules*`, `/api/accounts/:id/collections` (and `/collections/run`), `/api/accounts/:id/arrangements`, `/api/arrangements/:id/cancel`, `/api/collections/*` |

## Settings → Dunning rules

**Settings → Back office → Dunning rules** (short link `/settings/dunning-rules`; `settings:manage`) is where rules are built.

* **Rules** are listed by priority with their conditions and a one-line view of the ladder. With no rules yet the page offers **Load Southeast Asia defaults** for a market. A rule can be switched on and off.
* **The ladder builder** (Edit, or New rule) has the conditions at the top (market, customer type, segments, VIP, credit risk, priority) and the ladder below. **Drag a step from the palette into the ladder**, drag steps to reorder them, or use the arrows and the tap-to-add buttons (the same things work with a keyboard or on a phone). Each step opens to set its trigger (day, or overdue balance), its action's settings (channels, message and QR code; late fee; team and hold; how the debt is treated) and what it skips (disputes, VIPs, arrangements). The page warns when steps are out of day order and offers to sort them; the server refuses an order that makes no sense and says why.
* **Partial payments** sit at the bottom of the rule: the threshold, what to do, and how long to pause.
* **Late fees**, **Payment links and QR codes** (pay page address, credit bureau, merchant details per QR scheme) and **Where an account stands** (paste an account ID to see the rule that fits it, how many days past due, and each step's state: done, due now, held and why, later) are on the same page.

## Limits

Every number the Dunning rules screen caps and the server checks comes from one definition, `packages/core/src/dunning-limits.ts`. `GET /api/settings/dunning-rules` sends it as `limits`, and the screen's input maxima, character counters, the step counter ("12 of 30 steps") and its hints all read it; the browser never imports core. The router's schema checks only the shape (and a structural cap equal to the largest value the setting can take); `dunningRuleProblems` does the real check against the current values.

| Limit | Value | Set by |
|---|---|---|
| Most steps in a ladder | 30 (can be 1 to 100) | operator: **Settings → Dunning rules → Limits** (`POST /api/settings/dunning-rules/limits`, stored in settings key `dunningLimits`) |
| Highest priority | 1,000 (can be 1 to 100,000); lowest is 0 | operator, same place |
| Rule and step name | 80 characters | fixed |
| Rule description | 400 characters | fixed |
| Own message | 1,000 characters | fixed |
| Team name | 60 characters | fixed |
| Day past due, and the "at least N days" of a balance trigger | 0 to 365 | fixed |
| Case task due in | 1 to 1,440 hours | fixed |
| Case task holds later steps for | 1 to 90 days | fixed |
| Partial payment threshold / pause | 1 to 100 % / 1 to 60 days | fixed |

The setting itself is validated on save (whole numbers inside the ranges above; nothing else is changed if one is wrong). **Lowering a limit never breaks existing rules.** Rules over the new limit still load, list and open as before and keep running; the page lists them under Limits and marks them "Over the limits". Saving one is refused with what to fix ("A ladder has at most 10 steps; this one has 35. Remove 25", "Priority is a whole number from 0 to 100 (this rule has 4000...)"). Switching a rule on or off (`POST /api/settings/dunning-rules/:id/active`) does not re-check the limits, so an over-limit rule can always be switched off.

## QR merchant account tags

The merchant account of a QR payment code goes in a tag from **26 to 51**. In the EMV merchant-presented QR specification tags 00 and 01 are the format and initiation method, 02 to 25 are templates reserved for the card networks, 26 to 51 are merchant account information for every other scheme, and 52 onwards are fixed fields (category, currency, amount, country, name, city, additional data, CRC). The code writes 26 (SGQR / PayNow) and 29 (PromptPay) itself and takes an acquirer-issued tag for DuitNow, QRIS and QR Ph. Earlier the server accepted 02 to 51 while the screen said 26 to 51; the server now accepts 26 to 51 only (`QR_MERCHANT_TAG_MIN/MAX` in `emv-qr.ts`), and the label is built from the same two numbers. A merchant saved earlier with a tag from 02 to 25 must be re-entered with the tag the acquirer issued.

## Removing a rule

A rule cannot be removed while accounts are still being chased under it (a dunning run that is `ACTIVE`); switch it off instead and they finish the ladder they started. Nothing else blocks removal: finished runs keep their own frozen copy of the ladder and their history. The confirmation on the screen says exactly this.

## The Temporal ladder

`dunningLadderWorkflow` (`services/order-service/src/workflows/dunning-ladder.workflow.ts`) keeps the time for one account's rule-driven ladder. It does not carry a list of steps. It asks the CRM what the ladder is today, sleeps on a durable timer until the next step's day (a held step or a balance trigger is looked at again every 24 hours), has the CRM apply what is due, and reads again. So it follows a partial-payment reset, a pause, a broken arrangement or a closed dispute without knowing about any of them.

* **Signals.** `paymentReceivedSignal` (a bank or QR payment webhook, cash at a store): the ladder stops and the customer is told service is back. `partialPaymentSignal`: the workflow reads the ladder again (the rule's partial-payment policy has already been applied in the CRM). Query: `ladderStatus`.
* **Outcomes.** `PAID`, `TERMINATED`, or `COMPLETED` when no step is left.
* **API.** `POST /meridian-api/dunning-ladder/accounts/:id` starts one (one per account), `.../payment` and `.../partial` signal it, `GET .../accounts/:id` is its status.
* **Activities.** `getLadder` is `GET /api/accounts/:id/collections` and `runLadder` is `POST /api/accounts/:id/collections/run` (`billing:run`), which applies what is due. The worker ships stubs, as for the other workflows, until it is wired to the CRM with a service credential. The CRM works fully without the workflow: the daily job (`POST /api/lifecycle/run`) does the same work. The older `dunningWorkflow` still runs the single lifecycle ladder.

## Which rule applies

A rule has a **priority**, an optional **market**, a **customer type** (individual or business), **segments**, **VIP** (any, yes, no) and **credit risk** (any, high, normal; set on the customer by an administrator). Every condition that is set must match. Of the rules that match, the highest priority wins; on a tie the more specific one (more conditions set). The rule and its version are frozen on the account's dunning run when it starts, so editing a rule never changes a ladder already under way; the next run uses the new version.

## Steps

Each step has a name, a trigger, an action, parameters and exclusions, and can be switched off.

* **Trigger.** *Days past due* (D+X, from the due date of the oldest unpaid invoice) or *overdue balance* at or above an amount, optionally after a minimum number of days.
* **Actions.**

| Action | What it does |
|---|---|
| `NOTIFY` | SMS, e-mail and/or WhatsApp from a template (or your own text). Can carry a **QR code and pay link**. A step marked *final* also states the early-termination charge, the termination date and the credit-bureau warning. |
| `LATE_FEE` | Charges a late fee (below) as a separate invoice. |
| `CASE_TASK` | Opens a case for a team (for example *Account management*) due in N hours. It can **hold later bars, terminations and the transfer to debt collection** (`COLLECTIONS_TRANSFER`) for a number of days while the task is open. |
| `SOFT_BAR` | Outgoing blocked; incoming calls and SMS, and the self-service app and payment portal (zero-rated), still work. |
| `HARD_BAR` | Full service block; emergency calls exempt. |
| `TERMINATE` | Terminates every service (quarantining the number, charging the ETC) and deals with the debt: write it off (Dr 6100, Cr 1200), place it with the collection agency, or both. |
| `COLLECTIONS_TRANSFER` | Places the debt with the agency without terminating. |

* **Exclusions** (per step): *open billing dispute* (a customer case in the billing-dispute category), *VIP protection*, *payment arrangement being kept*. A step that is excluded is held, with the reason shown, and is looked at again on every run; it applies once the reason goes away.
* **Order.** Days never go backwards, a bar never follows a harder bar, nothing follows the termination, and a ladder terminates once. A late visit catches up: all due steps run in order, but only the harshest due bar is applied (the softer ones are marked superseded).

## Late fees

**Late fee configurations** are flat, or a percentage of the overdue balance (basis points) with a least and a most. A fee is billed as an `ADJUSTMENT` invoice on the GL account **4300 Late fees**, not added to the original invoice, and is untaxed unless the configuration says it is taxable.

## Partial payments

A rule's *partial payment* policy says what a payment that leaves something overdue does: when it covers at least the threshold (for example 80%) of what was overdue, either **reset to soft bar** (a hard bar is lifted to a soft bar, harder steps are marked reversed and apply again later) or **pause** the ladder, in both cases for a number of days. Below the threshold nothing changes. Paying everything overdue restores service in the same transaction that records the payment, with the unbar instruction queued as `URGENT`, so the line is back within the network's normal pickup time. Cash at a store, a gateway or a webhook all go through the same payment code.

## Payment arrangements

`POST /api/accounts/:id/arrangements` records instalments (1 to 36) that add up to at least what is owed. While the customer keeps to them, steps with the *payment arrangement* exclusion are held. Kept means: by each instalment's date plus a grace period (default 2 days), payments since the arrangement began add up to the instalments due so far. Missing that **breaks** the arrangement and dunning carries on from where it was; paying all of it **completes** it.

## Collection agencies

A `TERMINATE` (debt mode *collections* or *both*) or `COLLECTIONS_TRANSFER` step creates a **placement** (the balance, the customer and the run). `POST /api/collections/export` writes the agency file as CSV in a numbered batch (`COL-YYYYMMDD-NNN`) and marks the placements exported. A payment made against placed debt is counted as **recovered**; a placement can be **recalled** with a reason. Requires `collections:manage`.

## QR payment links

Set up under *payment settings* (`POST /api/settings/dunning-rules/payments`, administrators): the pay page address (https), the merchant details for each QR scheme and the bureau name used in final demands.

| Scheme | Market | How the code is built |
|---|---|---|
| PromptPay | TH | built in from the biller's phone number or tax ID |
| PayNow | SG | built in from the company UEN |
| DuitNow QR | MY | the merchant account field supplied by the acquirer |
| QRIS | ID | the merchant account field supplied by the acquirer |
| QR Ph | PH | the merchant account field supplied by the acquirer |

Codes follow EMVCo merchant-presented mode (TLV with a CRC-16/CCITT-FALSE checksum) and carry the amount and invoice reference. A hosted pay page is not built: the message carries the code and the configured address. Check a new setup against the acquirer's test tool before going live.

## Starter rules for Southeast Asia

`POST /api/settings/dunning-rules/seed` (or `pnpm --filter @meridian/core seed:dunning [MY|SG|TH|PH|ID]`; the demo seed installs it for the regional market) creates, once, for a market: a late fee (SG flat 5.00; MY 1.5% between 5 and 100; TH 1.5% between 100 and 2,000; PH flat 150; ID flat 25,000) and four rules, with that market's QR scheme. Running it again changes nothing, and rules you have edited are kept.

* **Consumer standard** (priority 10, everyone else): D+1 reminder (SMS, WhatsApp, QR); D+7 first notice and late fee; D+14 soft bar; D+21 hard bar; D+35 final demand; D+45 terminate, write off and place with the agency. Partial payment of 80% or more: reset to soft bar and pause 7 days.
* **Consumer VIP** (priority 200): longer grace, a task for customer care before any bar, soft bar D+30, hard bar D+60, and a task to decide on termination (no automatic termination).
* **Enterprise and business** (priority 200): an account manager task at D+14 that holds the bars, soft bar D+30, hard bar D+60, final demand D+75, confirmation task D+80, termination D+90.
* **High risk** (priority 300, customers flagged as high credit risk): reminders, charges and bars come sooner and the ladder ends at D+30.

## Permissions

`settings:manage`: rules, late fees, payment settings, the starter set, and marking a customer VIP or high credit risk. `collections:manage` (billing operations, customer service, team leads, finance): arrangements and agency placements. `billing:read`: an account's ladder view. `billing:run`: running dunning.
