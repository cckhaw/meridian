# Dealer and sales-agent commission

A rules-driven engine that works out what each seller earns when an order completes, keeps every amount in an append-only ledger, takes commission back when a customer leaves early, and settles monthly by statement, bank or payroll file, and GL posting.

| Piece | Where |
|---|---|
| Schema (hierarchy, plans, rules, claw-back policies, ledger, statements, payouts) | `packages/db/migrations/0027_commission.sql` |
| Rule evaluation (`CommissionCalculator`, slabs, claw-back policy maths, validation) | `packages/core/src/commission-calculator.ts` (pure, no database) |
| Plans, hierarchy, who earns by which plan, recording earnings, ledger queries | `packages/core/src/commission.ts` |
| Approval, claw-back, month close, statements, payouts, the daily job | `packages/core/src/commission-processor.ts` |
| Portal | Commission page: Earnings, Statements, Plans, Dealer channel, Close & payouts |

## Who earns

* **Indirect channel:** dealers form a tree (master distributor, dealer, sub-dealer, franchise outlet; at most six levels, no loops). A dealer earns by its own plan, otherwise the nearest ancestor's, otherwise the plan of the order's channel. A plan can pay **upline override** commission: a percentage of the same sale to the dealer above, then the one above that.
* **Direct channel:** a staff salesperson earns by a plan assigned to their username, their store, or the channel (retail, telesales, call centre). A sale with nobody attributed earns only through a plan assigned to its store (tracked as store commission) or to the self-serve channel (house commission). Store and house commission is recorded but never booked or paid.
* Precedence: dealer (then its parents), salesperson, store, channel. An actor has one plan.

Orders still decide who sold them from the session, never from the request body.

## Plans, rules and volume bands

A plan holds **rules**, **claw-back policies** and settings (days an earning is held before approval, override percentages). Each sale line is paid by exactly one rule: the most specific that matches (specific offers, then offer kinds, contract length, seller tier), then the lowest priority number.

A rule matches on offer kinds, offers, contract length (0 = SIM-only, 24 = a 24-month contract; a device bought on a contract carries its term to the plan it is attached to) and seller tier. It pays a **percentage of the sale value** (net price plus the first month of a plan) or a **fixed amount per activation**.

**Volume bands** count activations per beneficiary per month under that rule, for example 5% to 50, 8% from 51 to 100, 12% above 100. Two modes:

* **Marginal:** each activation earns the rate of the band its position falls in (the 51st earns 8%).
* **Retroactive:** reaching a band lifts every activation of the month to that rate; the month close pays the difference as an accelerator.

A band can also carry a **bonus**, paid once at month close to a beneficiary who reached it. Closing twice never pays twice.

## The ledger

`agent_ledger_entries` holds `EARNING`, `OVERRIDE`, `ACCELERATOR`, `BONUS`, `CLAWBACK` and `ADJUSTMENT` entries with status `PENDING`, `APPROVED`, `PAID` or `CLAWED_BACK`. Each entry records the rule, the slab and the numbers behind its amount. A database trigger forbids deletes and any change to amount, beneficiary, order or rule; only status, approval and payment stamps and the claw-back bookkeeping move. A sale line earns once per beneficiary.

* `ORDER_COMPLETED` is the order engine completing an order (in the same transaction), which calls `recordOrderCommission`.
* PENDING becomes APPROVED when the plan's hold has passed (daily job) or when finance approves entries by hand.

## Claw-backs

A policy names the triggers (`TERMINATION`, `PORT_OUT`, `ORDER_CANCELLED`), the windows (for example 30 days at 100%, 90 days at 50%; nothing after the last), an optional minimum contract length, and whether upline override is taken back too. The policy with the longest matching minimum contract wins.

When a service is terminated or ported out, or goods are returned, each ended service takes back its share of the line's earning at the percentage of the window it fell in. A negative `CLAWBACK` entry records it and the GL is reversed. If the whole of an unpaid earning is taken back, the earning and its reversals are marked `CLAWED_BACK` and never reach a statement. If it was already paid, the reversal is netted into the next statement. A sweep in the daily job catches services that ended without a claw-back; each service is processed once.

## Settlement

1. **Close a month** (Commission → Close & payouts, or `POST /api/commission/close`): approves what is due, pays accelerators and bonuses, and issues one statement per payee for everything approved and unsettled to the end of that month. A payee whose claw-backs exceed earnings gets no statement and the balance carries forward. The daily job does this on the 1st when the automatic close is switched on.
2. **Payout file:** a CSV for bank transfer (dealers, with bank code, account, SAP vendor number) and payroll (staff). Statements for dealers with no bank account on file are left out and named.
3. **Confirm:** once the bank has paid, confirming marks statements and lines PAID and books the payout.

Statements download as CSV and dealers see only their own.

## General ledger and SAP

Each payable entry posts a journal: expense `6200` against payable `2300` when earned, the reverse when taken back; a confirmed payout posts payable `2300` against disbursement clearing `1150`. These are ordinary journals in the sub-ledger, so Finance's posting rules map them to SAP accounts and cost centres (sample rules for the three accounts are seeded; replace them with the company's). Entries are described by dealer id, so a DETAIL-mode SAP export shows spend per dealer; the vendor number travels in the payout file.

## Permissions

`commission:read` (own earnings and statements for dealer and store logins, everything for staff), `commission:configure` (plans, rules, bands, policies, assignments, the dealer channel, bank details; finance), `commission:settle` (approve, close, payouts; finance). See `ROLES.md`.

## Starting state and limits

* Migration `0027` turns existing `commissions` rows into ledger entries and seeds plans paying what the flat rates did (3% retail, 5% dealer, 4% telesales) with a 30-day/90-day claw-back. Edit them in Plans.
* Bank details are stored as entered; encrypt the column or use a vault reference for production if policy requires.
* The scheduled workflow runs from the daily lifecycle job, not as a Temporal workflow.
* The payout file is a generic CSV; map it to the bank's format (for example ISO 20022 pain.001) at the integration layer.
* One currency (the regional currency); a payout file cannot mix currencies.
