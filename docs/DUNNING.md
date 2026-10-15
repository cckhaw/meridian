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
| API | `/api/settings/dunning-rules*`, `/api/accounts/:id/collections`, `/api/accounts/:id/arrangements`, `/api/arrangements/:id/cancel`, `/api/collections/*` |

Not built yet (next release): the drag-and-drop ladder builder page at **Settings → Dunning rules**, and the Temporal `DunningLadderWorkflow`. Until then rules are managed through the API (or installed from the starter set), and the existing `dunningWorkflow` in `services/order-service` keeps running the older ladder.

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
| `CASE_TASK` | Opens a case for a team (for example *Account management*) due in N hours. It can **hold later bars and terminations** for a number of days while the task is open. |
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
