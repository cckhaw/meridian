# Service lifecycle: suspension, dunning, termination

How a service moves between states, who can move it, and what money and network instructions follow. Rules are in `packages/core/src/lifecycle*.ts`; the knobs are the lifecycle settings (`GET/POST /settings/lifecycle`; there is no Settings screen for them yet).

## States

```
PENDING ──► ACTIVE ◄──► SUSPENDED
              │            │
              ├► PORTING_OUT ──► (back to ACTIVE if cancelled)
              ▼            ▼            ▼
                       TERMINATED
```

A transition not in `TRANSITIONS` (`lifecycle-state.ts`) is refused whoever asks, with a message naming the states that are allowed. A soft bar or data throttle keeps the service `ACTIVE` (incoming calls still work); a hard bar or a voluntary suspension is `SUSPENDED`. Why a service is restricted is `suspension_kind` (`VOLUNTARY`, `CREDIT`, `DUNNING`, `FRAUD`, `ADMIN`) and what the network is told is `bar_level` (`NONE`, `THROTTLE`, `SOFT`, `HARD`). Every change is written to `service_lifecycle_events` (`GET /services/:id/lifecycle`).

Everything that must reach another system (policy control PCRF/PCF, HLR/HSS, SMS and email, collections, the ledger) is written to `lifecycle_outbox` in the same transaction as the change. A delivery adapter reads `GET /lifecycle/outbox?pending=1` and acknowledges with `POST /lifecycle/outbox/ack`. Instructions: `THROTTLE_DATA`, `BAR_OUTGOING`, `BAR_ALL` (emergency calls always allowed), `RESTORE`, `DEPROVISION`, and notifications such as `PAYMENT_REMINDER` and `FINAL_NOTICE`.

## A. Voluntary suspension (the customer asks, e.g. overseas travel)

`POST /services/:id/actions { action: 'suspend-voluntary', months | until }`, by a call-centre agent (`service:suspend`) or by the customer in the portal (`service:self`, only on their own services).

- The service must be `ACTIVE`, unrestricted, and the account must owe nothing overdue.
- Duration is capped (**6 months** by default; lifecycle settings). Over the cap is refused. Staff can always do it for a customer; the portal option can be switched off.
- The MSISDN and SIM stay with the service. The network is told to bar everything but emergency calls and to retain the identity.
- **Charges.** Each offer says what a suspension costs, in the catalog (`suspension: { mode: 'PAUSE' }` the default, or `{ mode: 'MAINTENANCE_FEE', monthlyFeeMinor }` set through the catalog API). The bill run prorates the recurring charge for the days in service and adds the maintenance fee for the days suspended, in the bill after the return.
- **Resume.** The customer or staff resume at once (`action: 'resume'`), or it resumes by itself on the end date (the daily job). Service returns instantly; the proration happens on the next bill.
- `GET /services/:id/restoration` tells the portal why a service is restricted, what is owed and whether the customer can lift it.

## B. Credit limit and threshold breach

`POST /accounts/:id/credit-check { unbilledUsageMinor }` (the charging system, per event or from the daily rating). The limit is the account's (`PATCH /accounts/:id/credit-limit`) or the default in Settings (0 = not enforced).

- At **80 %** (configurable) the customer is warned once (`CREDIT_WARNING`).
- At **100 %** every unrestricted service gets a **soft bar** (outgoing calls/SMS and data blocked, incoming allowed; `BAR_OUTGOING`) or a **data throttle** (`THROTTLE_DATA`), sent at once to policy control.
- The restriction lifts when usage drops back below the threshold, the limit is raised, or the next bill resets the usage. A customer cannot lift a credit restriction themselves; staff can. Services already restricted for another reason are left alone. Repeating the same reading does nothing.

## C. Dunning ladder

D is the due date of the oldest unpaid invoice. **Dunning rules** ([DUNNING.md](DUNNING.md): ladders per market, customer type, segment, VIP and credit risk, with late fees, QR payment links, exclusions, partial-payment handling, payment arrangements and collections) take precedence. This single ladder, set in the lifecycle settings, is what an account follows when no active rule fits it, and an account already part-way down it finishes it. The default:

| Day | Step | Effect |
|---|---|---|
| D+1 | `REMIND` | SMS/email reminder; service stays active |
| D+7 | `SOFT_BAR` | outgoing calls and data blocked, incoming calls/SMS allowed |
| D+14 | `HARD_BAR` | full bar, emergency calls exempt (a voluntary suspension gives way to it) |
| D+30 | `FINAL_NOTICE` | notice with the balance and the estimated early-termination charge |
| D+45 | `TERMINATE` | every service on the account is terminated (below) and the debt is handed over |

A ladder must have steps in order, each at most once, bars only getting harder, nothing after the termination. Each step applies once per run (`dunning_runs`, `dunning_steps`). If the job missed days, steps in between are caught up and only the harshest due bar is applied. **Paying** everything overdue lifts the bars at once and closes the run. After termination the debt goes to **collections** (invoices flagged, `HAND_OVER` instruction) or is **written off** to the ledger (Dr 6100 Bad debt expense, Cr 1200 Receivables; invoice `WRITTEN_OFF`), as set.

Two ways to run it, the same rules: the daily job (`POST /lifecycle/run`, which also resumes ended suspensions and releases rested numbers) or per account (`POST /accounts/:id/dunning`). The rule-driven ladder has its own Temporal workflow, `dunningLadderWorkflow` ([DUNNING.md](DUNNING.md#the-temporal-ladder)). The workflow below (`services/order-service/src/workflows/dunning.workflow.ts`) runs one ladder per account on durable timers and wakes on `paymentReceivedSignal`; it asks the CRM before each step whether anything is still overdue, so a cash payment at a store also stops it. It starts and signals through `POST /meridian-api/dunning/accounts/:id` and `.../payment`. Its activities are stubs until wired to the CRM API calls named in `activities/dunning.ts`.

## D. Termination and the early termination charge

`action: 'terminate'` (`service:terminate`). The closing invoice has: recurring charges since the last bill (prorated to the day, less days voluntarily suspended), usage not billed yet (`unbilledUsageMinor`), and the **ETC** for a contract still running. For a plan that claws a device subsidy back:

```
ETC = remaining months × monthly recurring fee   +   unamortised device subsidy
```

(`method: 'RECURRING_PLUS_SUBSIDY'`; the older methods charge one or the other.) The waiver window in the last months still applies. **Adjustments for retention and VIP cases:** `etcAdjust: { waive | percent, reason }` (needs `order:override`, audited), and customer segments that are never charged (`termination.waiveEtcSegments` in Settings). Forced terminations (fraud, dunning) carry the ETC like any other.

On termination the number rests in **quarantine** for 90 days (configurable) before it can be recycled, the SIM is released, and `DEPROVISION` goes to HLR/HSS/PCRF. The daily job releases numbers that have rested.

### Early termination charge rules (Settings → Early termination)

The charge for ending a contract early is worked out by **rules**, one per situation, each with a **formula** you write. A rule says when it applies (the situation, the customer segment, VIP or not, a device on the contract or plan only, the contract length and the months already served) and what to charge. The rule with the highest priority that fits is used.

* **Situations** (scenarios): the customer ends the contract early; the number is ported out; we terminate for non-payment; a move to a cheaper plan during the contract; transfer to a new owner; relocation where we have no service; death, serious illness or hardship; a persistent fault on our side; force majeure or a regulatory change. Termination chooses its situation from how it happens (a port-out is `PORT_OUT`, a dunning termination `NON_PAYMENT`, otherwise `CUSTOMER_REQUEST`) or from the `scenario` the caller gives.
* **Formulas** are arithmetic over named values, never code: `term`, `elapsed`, `remaining` (months), `monthlyFee`, `subsidy`, `retailPrice`, `deviceBalance` (instalments not yet billed), `deviceInstalment`, `newMonthlyFee` (plan change only) and `vipMultiplier`, with `+ - * / %`, comparisons, `&& || !`, `condition ? a : b`, parentheses and `min`, `max`, `round`, `floor`, `ceil`, `abs`, `clamp(x, lo, hi)`, `pct(x, percent)`. A formula is checked as you type and when it is saved. Amounts are in the smallest currency unit. Example: `subsidy * remaining / term + monthlyFee * remaining * 0.25`.
* **Limits**: a least and a most charge, no charge in the last N months, whether a VIP number's multiplier applies, and the **share of the unpaid device instalments collected** on the final bill (as its own line, *Outstanding device instalments*).
* **Try it** on the same page shows which rule fits some figures and what it would charge; nothing is saved.
* **Standard set**: eight rules for the usual situations to start from. Add them with one click; rules you have changed are kept.
* **Where it applies**: the termination itself and its closing invoice, the termination and port-out quotes in the billing simulator, the plan-change preview, and the estimate in the final notice of the dunning ladder.
* **While no rule is switched on**, the contract terms on each offer decide, exactly as before, and unpaid device instalments are not collected. With rules on and none fitting a case, the offer's terms decide the charge and the unpaid instalments are collected in full.

API: `GET/POST /api/settings/etc/rules`, `PATCH/DELETE /api/settings/etc/rules/{id}`, `POST /api/settings/etc/standard`, `/check` and `/preview`; `settings:manage`.

## E. Port-out

`POST /mnp/port-out/confirmation { serviceId | identifier, reference, unbilledUsageMinor }` when the national clearinghouse confirms. The service is terminated at once with a closing invoice (recurring until today, usage not yet billed, ETC), the account's deposit is applied to it and the rest refunded when this was the last service (`POST /accounts/:id/deposit` takes deposits), the SIM and network resources are released, and the number is **not** recycled: it belongs to the other operator. The call is idempotent, so the clearinghouse can retry.

## Permissions

`service:self` (a customer pausing and resuming their own line) is new and held by the portal role. Suspend/resume by staff stay `service:suspend` / `service:manage`; termination `service:terminate`; waiving an ETC `order:override`; credit readings, the daily job and dunning `billing:run`; port-out confirmation `mnp:manage`; the rules `settings:manage`.
