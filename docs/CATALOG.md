# Product catalog

## Hierarchy

**Network type → Category → Group → Offer → Line item**

| Level | What it is | Examples |
|---|---|---|
| Network type | the technology / business line | Mobile, Fibre, IoT |
| Category | a family of products | Postpaid, Wearables |
| Group | a shelf customers browse | SIM only, Device, Insurance |
| **Offer** | the thing that is sold: price, contract, fulfilment, rules | 5G Plan + Phone (24 mo) |
| **Line item** | one component an offer includes | 100 GB data · Unlimited calls · Phone X1 128GB |

Every level can be added, renamed, moved, reordered, retired and (when empty and never sold) deleted from **Catalog**. Moving re-parents everything beneath it.

## Using the catalog page

The catalog page works like Files: the folder you are in on the left (one level at a time, a page of 50 with **Show more**), the thing you picked on the right. Tap a network type, category or group to go inside; the path above the list (**Catalog › Mobile › Postpaid**) is the way back out. Choose an offer to see it on the right in sections: **Included** (its line items), **Pricing**, **Rules** (dependencies, channels, markets, fulfilment) and **Sales** once it has subscribers.

Search is on the server and covers the whole catalog by words in the name or code (`100gb fam` finds *Family 100GB*); each result shows where it lives, and opening it takes you there. Nothing loads the whole tree, so the page stays quick with tens of thousands of offers (see [Working with millions of records](SCALE.md)). The selection is in the address (`/catalog?node=…`), so items can be linked to and Back works. On a phone it is one screen at a time with a Back button. Actions live behind a single **⋯** menu per item; **Edit offer** opens the full offer form, whose pickers (group, prerequisites, exclusions) are searches rather than long drop-downs.

## Creating an offer: the guided flow

**Catalog → New offer** is a short guided flow, and what you choose decides what it asks next:

1. **What is it?** The group it sits in, the **offer type**, and the name. The type decides the rest of the flow.
2. **Pricing.** Monthly fee (not for outright goods), upfront price, whether prices include tax, and the contract term (not offered for outright goods). A subsidy only appears for offers that include a device. **Currency and the tax name and rate come from Settings → Regional format**, so they always match what is set there.
3. **Fulfilment.** How the customer gets it, from the list in Settings: delivered, **collect in store**, installation, SIM activation. Add-ons skip this step.
4. **Stock.** Only if a chosen fulfilment option tracks stock: the SKUs reserved when it is sold, and (for devices) colours and storage. A SIM-only plan shows no stock step unless you have turned on stock tracking for SIM activation.
5. **Availability.** Channels, and the partner code for partner subscriptions. The market appears here only when several markets are switched on (see below).
6. **Rules.** Optional prerequisites and exclusions.
7. **Review.** A summary with Edit links, then choose **Draft** (not sellable), **Scheduled** (goes live on a date) or **Active** (sellable now) and create. A scheduled offer needs a go-live date after today; it is hidden from every sales channel until the start of that day, then becomes Active by itself (the server notices a due offer within about 15 seconds). Moving it back to Draft clears the date. Editing an existing offer uses the same steps and lets you jump to any of them.

## When an offer can be sold

An offer is **sellable now** only when the offer is **Active** and every node above it (group, category, network type) is **Active** too. A draft, scheduled or retired parent hides everything beneath it, whatever the offers' own status; a scheduled node counts as not live until its go-live day. This is one rule (`isSellableNow`, `allAncestorsLiveSql`, `assertAncestorsLive` in `packages/core/src/catalog.ts`) used everywhere a sale can start:

- **Listings used for selling** (`GET /catalog?forSale=1`, any list with a channel, order step or outright filter, the new-order wizard, change-plan, move-to-group and family-plan pickers, add-on suggestions, the online store) leave such offers out. The check is part of the SQL query, so a page costs the same however large the catalog is.
- **Quote and order placement** (`priceBasket`, so also the northbound, partner and store APIs and group plans) refuse them: *"5G SIM-only 100GB is not on sale: its group Home plans is retired."* The message names the node nearest the root that is not live and its state (retired, still a draft, scheduled and not live yet).
- **Plan change** (immediate, scheduled and its agreement preview), **adding a value-added service** and **moving lines to a group plan** refuse them with the same message. A plan change scheduled earlier is not applied if the target's parent has been retired since.
- **Catalogue browsing by staff** (the Catalog screen, `GET /catalog` without a sale filter, with or without a `status` filter) still lists everything, so retired parts can be managed and reactivated. Reactivating the parent makes the offers sellable again at once.

Nothing already sold changes: existing orders, services, billing, invoices and renewals never look at the parent's status, so retiring a group does not stop a customer being billed for a plan they already have. Bulk offer import and export are not affected.

## What an offer type is

An **offer type** says what kind of thing an offer is. It decides what the flow asks for and what happens when the offer is sold: whether a service is created, whether something ships, whether a contract is offered. The type list is in **Settings → Catalog → Offer types**: add your own, rename them, or switch off the ones you do not use.

### Switches

A type is a set of **switches**. A new type starts from one of the eight built-in presets (the "Start from" list) and you change whatever differs:

| Switch | Meaning |
|---|---|
| Service it creates | A service type (Mobile, Fibre, IoT, Subscription, or one you defined) or none |
| Only if it has a monthly fee | A watch with no plan is just goods |
| Includes a physical item | Ships or is collected; can have colours and storage |
| Sold outright | Goods with no service and no contract; can be a quick sale |
| Contract | None, or a term can be offered |
| Needs a partner | Asks for the partner's code |
| Needs installation | The service starts when installed |
| Where it is picked | Step 1 plans, step 2 devices, step 3 add-ons (one or more) |
| One per order | At most one offer of this type per order (for example a mobile plan) |

The form shows a live summary and refuses combinations that make no sense (a type that neither creates a service nor includes goods, an outright sale with a service, installation without a service, and so on). The order engine reads the switches stored on each offer, so changing a type never rewrites history: the built-in presets are read-only, and a custom type can be edited freely until an offer uses it, after which only *Where it is picked* and *One per order* can change (they are restamped onto its offers).

The presets: SIM-only plan, plan with a device, wearable, fibre broadband, IoT connectivity, add-on, partner subscription, outright goods.

A switched-off type cannot be chosen for new offers; existing offers keep working. A type can be removed only if it is custom and no offer uses it.

### Service types

**Settings → Catalog → Service types** lists what an order can start: the four that come with the platform (Mobile, Fibre, IoT, Subscription) and any you define: a roaming pass, a voucher, a top-up. Choose one as the *service it creates* in an offer type.

**Built-in types** can be adapted by the super user (`settings:manage`): rename and describe them, and change how the outside world hears about them. Their identifiers (the number comes from the number pool; `FBR-`, `IOT`, `SUB-` for the rest), their life cycle (they never end by themselves) and their existence are fixed: they cannot be switched off or removed.

For **every** type, built-in or yours, you set:

* **Tell the network when a service starts** and the **start instruction** (default `PROVISION`). For your own types this is on; for the built-in ones it starts off, which is how they have always behaved (only end, bar and plan-change instructions were sent). Turn it on to send a start instruction for built-in types too.
* **Systems to tell** and the **end instruction** (default `DEPROVISION`). A built-in type that names no systems keeps the default, HLR, HSS and PCRF, so nothing changes until you adapt it. The systems and instruction are in the message sent to your integration.
* **Provision into the charging system (OCS):** off means services of this type are never sent to the OCS, and an offer of this type cannot be given an OCS plan code ([OCS.md](OCS.md)).

Types you define also have an **identifier prefix** (`RP-…`), can **end by themselves** after a default number of days (an offer can override it with **Valid for (days)**), and can be switched off or removed when nothing uses them.

When an order completes, a service of one of your types is created as a subscription with the type and its expiry. The daily job ends services past their expiry (reason `EXPIRED`) without a final invoice. Billing is ordinary subscription billing: a monthly fee bills monthly, a one-time price is paid once.

Limits: a type changes identity, expiry and provisioning, not billing rules or the order steps themselves. Old links to `?section=service-kinds` still work (the screen was renamed).

## Fulfilment options

**Settings → Catalog → Fulfilment options** lists the ways an offer can reach the customer. Each option works like one of four things, which decides when an order can still be cancelled:

| Works like | Cancel until |
|---|---|
| Delivered to the customer | it ships |
| **Collected in store** | the customer collects it |
| Installed by a technician | the technician is dispatched |
| SIM activation | the service is switched on |

Each option also says whether it **tracks stock**: offers using it then list the SKUs reserved when they are sold. For SIM-only plans, turn it on for SIM activation only if you count SIM cards in inventory.

## Offer line items

Line items describe what an offer includes. They are shown to customers (the store-front lists them on each card) and **do not change the price**.

- **Types:** data allowance, voice, SMS, SIM card, device, accessory, service, content/subscription, other.
- **Amount:** a whole number plus a unit (`100 GB`, `300 min`, `2 units`), or *Unlimited* for data, voice and SMS.
- **Stock (optional):** a device, accessory or SIM line item can carry an **inventory SKU**. When the offer is sold, that stock is reserved: line-item amount × number of offers ordered. A SKU may be listed once per offer: either in the offer’s own fulfilment list or on one line item, never both (the catalog refuses duplicates so stock is never reserved twice).
- **Status:** a line item can be hidden (draft/retired) without deleting it.
- **Lifecycle:** deleting an unsold offer deletes its line items. A sold offer cannot be deleted (retire it); individual line items can still be edited. *Create a new version* of an offer copies its line items.
- Line items are not sellable on their own and cannot be a prerequisite or a conflict in a dependency.

API: `POST /api/catalog` with `level: "LINE_ITEM"`, `parentId: <offer id>`, `itemType`, `quantity`, `unit`, `unlimited`, `sku`, `description`; edit with `PATCH /api/catalog/:id`; reorder and delete as for any node; `POST /api/catalog/:newOfferId/line-items/copy-from {fromId}`.

## Dependencies between products

See the offer form: *Customer must first have* (an offer, or "any offer in a group/category") and *Cannot be bought together with*. A prerequisite is met by the same order or by what the customer already owns.

## Devices on a contract with a plan

A phone does not need a "plan with a device" offer of its own for every plan. On a device sold **outright** (the Outright goods behaviour), the Pricing step has **Also sell on a contract with a plan**: add one to three contracts (12, 24 or 36 months), each with a **subsidy** the operator takes off the price and the number of **free last months** (no early-termination charge at the end).

When the device is added to an order together with a plan that has no device of its own (a SIM-only plan, for example), staff choose **On a contract** and the plan and length:

- the device costs its price less the subsidy, **spread evenly across the whole contract and billed with the plan** by default (the customer may pay in full instead, and a credit check can ask for an upfront part first: [FINANCING.md](FINANCING.md)); an instalment choice made on the line is kept;
- the plan switches on when the device is delivered, with that contract, and the device instalments are billed on the plan;
- leaving early charges the subsidy that has not been earned yet, whatever later happens to the catalog (the terms are saved with the service);
- returning the device in the cooling-off period keeps the plan but ends the contract and the instalments without a charge;
- the plan and its device are cancelled together while they are still cancellable.

The built-in **Plan with a device** type remains for fixed bundles of one plan and one phone.

## Bulk loading offers from a CSV file

Catalog → **Import or export offers (CSV)…** (needs the catalog-write permission).

1. **Download.** *Empty template* has the header and lists the group ids, offer type ids and fulfilment option ids you can use. *Template with my current offers* has a row for every offer, so prices and details can be changed in bulk and loaded back.
2. **Fill it in.** One row per offer. Columns: `group_id`, `offer_id`, `name`, `type`, `description`, `monthly_fee`, `upfront_price`, `prices_include_tax`, `contract_months`, `contract_free_months`, `etc_percent`, `subsidy`, `device_retail_price`, `fulfilment`, `stock_skus`, `colours_storage`, `device_contracts`, `channels`, `requires`, `excludes`, `partner_code`, `market`, `status`, `go_live_date`, `validity_days`, `ocs_plan_code`, `suspension_mode`, `suspension_fee`, `group_plan`, `max_group_members`, `allowed_member_offers`, `shared_pool_quota_gb`, `characteristics`. Amounts are plain numbers in the regional currency (`12.50`). Lists use `|`: `fulfilment` as option ids (`SHIP|SIM`), `colours_storage` as `Colour:Storage:SKU:price difference` (colons, because a SKU such as `MJW44LL/A` contains a slash), `device_contracts` as `months:subsidy[:free months]` (`24:400|12:200`). The last nine columns carry the newer terms: `validity_days` (how long an expiring service lasts; new offers only), `ocs_plan_code` (the plan in the charging system), `suspension_mode` (`PAUSE` or `MAINTENANCE_FEE`, with `suspension_fee`), a group plan (`group_plan` yes/no with `max_group_members`, `allowed_member_offers` and `shared_pool_quota_gb`; `no` on an existing offer turns the group plan off) and `characteristics` (`name=value` separated by `|`). Lines starting with `#` are ignored; up to 1,000 offers per file.
3. **The key is `offer_id`.** A row whose id already exists **updates** that offer (a blank cell leaves the field as it is; the group can be changed to move the offer); any other row **creates** one, as a draft unless `status` says `SCHEDULED` (with `go_live_date`, `YYYY-MM-DD`, start of the day in UTC) or `ACTIVE`. With no `offer_id` it is made from the name, so loading the same file again updates the same offers and never duplicates them. An id already used by a group, category or network type is refused.
4. **Check, then load.** The check runs exactly the code the offer form uses (type behaviour, currency, prerequisites, contract and subsidy rules, sold offers cannot be repriced) and then undoes it, so nothing changes. Each row is marked Create/Update and Ready or Problem with the line and the reason. The file loads only if every row is valid, and then all together.

API: `GET /api/catalog-import/template[?offers=1]` and `POST /api/catalog-import` with `{ "csv": "...", "apply": false }` (check) or `true` (load).

A stock SKU may contain letters, digits, dash, dot, underscore and slash (manufacturer part numbers such as `MJW44LL/A`), up to 50 characters. When an offer is refused, the message lists every rule it broke.

## Markets

Settings → Markets chooses how the CRM treats countries.

- **One market (default).** The whole CRM works in the country set under Settings → Regional format. No screen asks for a market; offers, logins, stores and customers are not tied to one; nothing is filtered or refused by market. The CSV `market` column is ignored.
- **Several markets.** Settings → Markets then lists the markets you sell in. For each you set the name, tax name and rate, and dial code (**Add a market** from the built-in list or define your own with a two-letter code; **Remove** drops one). Your own country is always in the list and takes its tax and dial code from Regional. A market that offers, logins, customers or stores still use cannot be removed. One market is the **default**: new logins, offers, customers, store-front sales and CSV-imported offers start in it when nobody picks one. An offer lists the markets it is sold in (blank means all), a login and a store belong to a market, and a customer's market decides which offers they can buy, the tax that applies and the dial code for new numbers. The deployment still has one currency (offer prices and the ledger are in it); the home country uses the tax and dial code from Regional and other markets use their own.

Switching never deletes data: offers, logins and customers keep the market they have, and the limits apply again when several markets are switched back on.

## Contract terms: early termination and suspension

- **Early termination charge (ETC).** An offer on a 12, 24 or 36-month contract says how a charge is worked out if the customer leaves early: `SUBSIDY_AMORTISED` (the device subsidy over the months left), `REMAINING_RECURRING_PERCENT` (a percentage of the remaining monthly fees), or `RECURRING_PLUS_SUBSIDY` (the remaining months times the monthly fee, plus the device subsidy not yet earned back). A waiver window in the last months applies to all. Retention and VIP waivers are applied at termination; see [LIFECYCLE.md](LIFECYCLE.md#d-termination-and-the-early-termination-charge).
- **When the customer suspends.** An offer's `suspension` terms decide what a customer-requested suspension costs: `PAUSE` (the default: no recurring charge while suspended) or `MAINTENANCE_FEE` with a monthly fee. They can change at any time, also on an offer already sold, and take effect on the next bill. They are set through the catalog API (`suspension` on an offer); the offer form does not show them yet.
