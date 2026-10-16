# Orders: fulfilment, cancellation and returns

Every order carries a readable number `YYYYMMDD-NNNNN`; orders that sell a SIM also hold a SIM card and number until activation. See [NUMBERING.md](NUMBERING.md).

An order is not one thing that ships or doesn't. A basket can hold a mobile plan, a phone that is posted, and a fibre line that needs a technician, and each of those has its own timeline and its own point of no return. Meridian therefore splits a paid order into up to three **fulfilment groups**:

| Group | What is in it | Moves through | Point of no return |
|---|---|---|---|
| **Goods** | anything that ships (phones, accessories, devices bundled with a plan) | pending → shipped (locked) → delivered | when it ships |
| **Installation** | offers that need a technician (fibre) | pending → technician dispatched (locked) → installed | when the technician is dispatched |
| **Activation** | services that are simply switched on (SIM-only plans, add-ons, subscriptions) | pending → active | when the service is switched on |

The order's overall state is derived from its parts: an open installation shows as *Awaiting installation*, else shipped goods as *Shipped*, else *In fulfilment*; when every part is finished the order completes (or is cancelled if nothing was delivered).

## When services switch on

- A plan sold **with a device** (a device contract) switches on when the device is **delivered**.
- A service sold **without** a device contract (a SIM on its own, a subscription, even next to an outright accessory) switches on as soon as the order is paid. Nothing waits for a plain accessory.
- Fibre switches on when the **installation is completed**, independent of anything else in the order.
- A counter sale (store or quick sale) hands the goods over immediately, so its goods part is finished at once.

## Cancellation

*The numbers in the next three sections (24 hours, 50.00, 14 days, 21 days) are the standard policy. Each is a rule you can change in Settings → Cancellation, described below.*

Cancelling an order cancels **every part that has not passed its point of no return**. The rest stays, and the screen says why. Each cancelled part is refunded on its own: stock is released, the appointment slot is freed, and the refund is posted to the ledger.

| Situation | Result |
|---|---|
| Nothing has shipped, been dispatched or activated | whole order cancelled, full refund |
| Phone shipped; fibre and SIM not started | fibre and SIM cancel and are refunded; the phone follows the return rule below |
| Installation booked, cancelled less than 24 hours before the visit | cancelled; a call-out fee (default 50.00) is kept |
| Technician dispatched | installation cannot be cancelled |
| Service already switched on | cannot be cancelled; end it as a service termination under its contract |
| Not yet paid | cancelled whole, nothing to refund |

**Bundle discounts are earned by the bundle.** If cancelling a part breaks a bundle (for example the fibre leaves a "fibre + phone plan" order), the discount on what remains is taken back out of the refund. Cancelling the whole bundle together never claws anything back.

**Instalments.** A device paid by instalments only collects the down payment at checkout, so cancelling it refunds the down payment. The instalment plan only starts when the service is activated, so nothing needs reversing.

## Returns (cooling-off)

Goods that have been **delivered** can be returned within **14 days**. The refund is what was paid for the goods, minus an optional damage deduction. Stock goes back, a device contract that came with the goods ends with no early-termination charge, and instalments stop. After the period, or once the goods are only shipped (not yet delivered), the return is refused with the reason.

## Installation service level

An installation still open after **14 days** is flagged *at risk* for follow-up. One that has not been dispatched after **21 days** is cancelled automatically with a **full refund** (no call-out fee: the delay is ours). A dispatched installation is never auto-cancelled. Run `POST /api/jobs/sweep-orders` daily (it needs the billing-run permission).

## The new-order wizard

CRM → New order walks through one decision per screen, with the running total always visible (a pill and sheet on a phone):

1. **Plan or product**, 2. **Device** (colour and storage with live stock, or add a device), 3. **Add-ons** (only ones this customer can buy, plus bundle savings and a hint when one more item completes a bundle), 4. **How to pay** (each line in full or by instalments with a down payment), 5. **Customer** (look up by ID number, mobile, e-mail or name, or create one), 6. **Delivery and installation** (address, preferred visit, and when each part can still be cancelled), 7. **Review** (entitlements, colour and storage, price, bundle discount, down payment and instalments, contract and early-termination terms, monthly total, cancellation terms; the customer must be confirmed as informed), 8. **Payment**, then submit.

Steps that do not apply are skipped (no device step for a quick sale, no payment-structure step when nothing can be financed, no delivery step for a counter sale without installation). Opening it from a customer's page starts with that customer chosen. Every number comes from the server's quote, so the review shows exactly what will be charged.

Device colours and storage are edited on the offer (Catalog → Edit offer → Colours and storage). Bundle discounts are managed at Catalog → Bundle discounts.

## The cancellation rule base (Settings → Cancellation)

Nothing above is hard-coded. Every decision comes from rules the super user edits in **Settings → Cancellation**, and changes apply to every order straight away (recorded in the audit log). The standard policy described in this document is installed the first time it is needed, and **Restore the standard policy** brings it back.

A rule says *what it decides*, *which part of an order it applies to*, *when* (conditions), and *then what* (outcome):

| Decides | Question it answers |
|---|---|
| **Cancelling** | May this part be cancelled, and what is kept? |
| **Returns** | May delivered goods be returned, and for how much? |
| **Flag as late** | When is an open part flagged for follow-up? (the sweep) |
| **Cancel automatically** | When does the system cancel a part itself and refund it? (the sweep) |

**Rules are tried top to bottom and the first enabled one that fits decides.** Use ↑ ↓ to change the order. If none fits, the **fallback** (refuse, or allow with a full refund) applies.

**Conditions** (all must be true): where the part is (not started / shipped or dispatched / delivered, installed or active), hours until the installation visit, hours or days since the order was paid, days since delivery, hours since it was shipped or dispatched, the condition of returned goods (as new / damaged / missing parts), who is acting (customer, staff, system), sales channel, customer segment, market, payment method, amount paid, whether it is financed, whether it has a contract, and the kind of product. Compare with *is*, *is not*, *less than*, *at most*, *more than*, *at least*, *one of*, *none of*.

**Outcomes**: allow or refuse; a fixed fee and/or a percentage of what was paid kept from the refund (with optional minimum and maximum); the percentage refunded (for restocking charges); for returns, the most that may be deducted for damage; and **supervisor approval** (allowed only for people holding the `order:override` permission, which Customer Service has).

Each rule reads back as a plain sentence (“Before the technician is dispatched, less than 24 hours before the visit: it can be cancelled; SGD 50.00 is kept.”). The same sentences, or a message you write, become the **cancellation terms** shown in the order wizard's review. **Try it** on the settings page simulates a situation and shows which rule decided, what it refunds, and why the rules above it did not apply.

Fixed by physics, whatever the rules say: goods that have shipped cannot be cancelled (they can be returned), and a service that is switched on cannot be un-activated by cancelling (it is terminated).

## Payment structure

Each line chooses how it is paid:

- **Upfront**: the full upfront price is taken at checkout.
- **Instalments**: choose 3, 6, 12, 24 or 36 months (never longer than the contract) and an optional **down payment**. Only the down payment is taken now; the rest is spread over the customer's bills from activation. Instalments are for one device at a time and need a service to bill against.

A basket can mix both: pay one device in full and finance another. The amount due now is always shown before submit.

## Devices: colour and storage

An offer can list **variants** (colour, storage, the stock SKU behind it, and a price difference). The chosen variant's SKU is reserved instead of the offer's own device SKU, its price difference is added, and the choice is stored on the order line and shown everywhere.

## Bundle discounts

Rules like "fibre + a phone plan = 10% off the phone" are data (`/api/bundle-rules`, catalog editors only): what must be in the order (`kind:FIBER`, `offer:<id>`), which line gets the discount, and a percentage or fixed amount off its upfront price. The quote and the order show each discount as its own figure.

## API for the order wizard

| Call | Purpose |
|---|---|
| `POST /api/orders/quote` | the whole review summary (entitlements, device variant, instalments, due now, monthly total, contract, cancellation terms per part) without saving anything |
| `GET /api/orders/addons` | only the add-ons this customer can buy with this basket |
| `GET /api/catalog/:id/availability` | stock behind each colour/storage choice at a location |
| `POST /api/orders` | place the order (same pricing as the quote) |
| `POST /api/orders/:id/actions` | `cancel` (optionally `groups`), `return`, `ship`, `deliver`, `schedule_installation`, `dispatch_technician`, `complete_installation`, `confirm_payment` |

`GET /api/orders/:id` includes `groups` with what each part can do right now (can it be cancelled, the refund and any fee, the return window) and `cancelAll`, the combined effect of "Cancel order".

## Selling through

All CRM orders are staff-assisted; customers order themselves only through the store-front (the *Self-serve* channel is not offered in the CRM). The **Selling through** panel on the first step of New order records who sold it:

| Channel | Who sold it | Store |
|---|---|---|
| Retail store | the signed-in store user (own login) | from the login (staff without a store pick one) |
| Quick sale (walk-in, goods only) | the signed-in store user | from the login, never from the request; offered to store users only |
| Call center, Telesales | the signed-in user (own login) | none |
| Dealer | the operator enters it **on the dealer’s behalf** and chooses the **dealer** and the **dealer agent** | none |

Retail, call-center and telesales users are created under Users & roles. Dealers and their agents are kept under **Dealers** (permission `dealer:manage`, held by the *Dealer Desk* role); an order for a dealer needs an active dealer and one of that dealer’s active agents, and the order records both (`dealer_id`, `dealer_agent_id`).

## What the customer is told

The review step lists, for each part of the order, short points in the order things happen: before it ships or is dispatched, once it has shipped, once delivered. They are generated from the cancellation rules, so they cannot disagree with what the system does or with each other. A rule that is narrower than a later one for the same stage (for example the late-visit fee) is followed by an "Otherwise" point.

## Collect in store

An offer can be delivered, collected in store, or both (Settings → Catalog → Fulfilment options). In the order wizard's delivery step the customer chooses when both are allowed; goods that can only be collected need a **collection store**. If one order mixes goods that can only be collected with goods that can only be shipped, the wizard asks for two orders.

- The stock is reserved at the **collection store**, not the warehouse.
- Staff mark the order **Ready for collection**, then **Customer has collected**. Until it is collected the goods have not left the store, so the order can still be cancelled with a full refund; once collected, the return rules apply as for delivered goods.
- Offers that can only be collected are sold in store and through staff channels, not in the online shop.


## Device on a contract with a plan

A device sold outright can also be bought on a contract with a plan (see Catalog → Devices on a contract with a plan). In the new-order wizard's Device step, choose **On a contract**, the plan and the length. The order line carries the plan it belongs to and the contract; the device price is the retail price less the subsidy and can be paid by instalments no longer than the contract. The plan switches on when the device is delivered, with the contract, and the device instalments are billed on the plan. The terms are saved with the service, so an early-termination charge (the unearned subsidy, nothing in the free last months) never changes when the catalog does. Cancelling the plan alone is refused while its device is part of the order; returning the device in the cooling-off period keeps the plan and ends the contract and the instalments without a charge.

### In the online shop

The shop lists each device's contracts (for example "24 months: $599 today, save $400") on its card. With a SIM plan in the basket, choosing a device offers **On a contract**: the plan, and the length. The basket total, the sign-up review and the order all use the contract price from the server, and the device is paid in full with the rest of the order (the shop does not offer instalments). The cart lines carry `attachTo` (the plan's offer id) and `dealTermMonths` through `/store/quote`, `/store/applications` and checkout.

## Identity and activation

With *When identity must be settled* at its default (before the service is switched on), an order for a customer whose identity check is in review is taken and paid, but its **service activation group stays pending** (the order shows a banner, and its tasks list *KYC*). Approval releases it; rejection cancels the order and refunds it. A fibre installation can be dispatched but cannot be completed until the check is approved. A customer whose check was rejected cannot be sold a service. See [KYC.md](KYC.md).
