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
2. **Pricing.** Monthly fee (not for outright goods), upfront price, whether prices include tax, and the contract term (not offered for outright goods). A subsidy only appears for offers that include a device. **Currency and the tax name and rate come from Settings → Regional**, so they always match what is set there.
3. **Fulfilment.** How the customer gets it, from the list in Settings: delivered, **collect in store**, installation, SIM activation. Add-ons skip this step.
4. **Stock.** Only if a chosen fulfilment option tracks stock: the SKUs reserved when it is sold, and (for devices) colours and storage. A SIM-only plan shows no stock step unless you have turned on stock tracking for SIM activation.
5. **Availability.** Channels and market, and the partner code for partner subscriptions.
6. **Rules.** Optional prerequisites and exclusions.
7. **Review.** A summary with Edit links, then choose **Draft** (not sellable), **Scheduled** (goes live on a date) or **Active** (sellable now) and create. A scheduled offer needs a go-live date after today; it is hidden from every sales channel until the start of that day, then becomes Active by itself (the server notices a due offer within about 15 seconds). Moving it back to Draft clears the date. Editing an existing offer uses the same steps and lets you jump to any of them.

## What an offer type is

An **offer type** says what kind of thing an offer is. It decides what the flow asks for and what happens when the offer is sold: whether a service is created, whether something ships, whether a contract is offered. The type list is in **Settings → Catalog → Offer types**: add your own, rename them, or switch off the ones you do not use. Every type is based on a **behaviour** that the platform knows how to sell, fulfil and bill, chosen when the type is created and fixed afterwards:

| Behaves like | What it does |
|---|---|
| SIM-only plan | A mobile plan with a SIM and no device; creates a mobile service |
| Plan with a device | A phone on a mobile plan, usually on contract; the service starts when the phone is delivered |
| Wearable | A connected watch or band; creates a service only if it has a monthly fee |
| Fibre broadband | Needs an installation; the service starts when it is installed |
| IoT connectivity | One IoT service per device, often bought in bulk |
| Add-on | An extra on a plan; creates a subscription |
| Partner subscription | A partner's service billed with the plan; needs the partner's code |
| Outright goods | A device or appliance sold outright: no service, no contract, can be a quick sale |

A switched-off type cannot be chosen for new offers; existing offers keep working. A type can be removed only if it is custom and no offer uses it.

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

- the device costs its price less the subsidy, upfront or by instalments no longer than the contract;
- the plan switches on when the device is delivered, with that contract, and the device instalments are billed on the plan;
- leaving early charges the subsidy that has not been earned yet, whatever later happens to the catalog (the terms are saved with the service);
- returning the device in the cooling-off period keeps the plan but ends the contract and the instalments without a charge;
- the plan and its device are cancelled together while they are still cancellable.

The built-in **Plan with a device** type remains for fixed bundles of one plan and one phone.

## Bulk loading offers from a CSV file

Catalog → **Import or export offers (CSV)…** (needs the catalog-write permission).

1. **Download.** *Empty template* has the header and lists the group ids, offer type ids and fulfilment option ids you can use. *Template with my current offers* has a row for every offer, so prices and details can be changed in bulk and loaded back.
2. **Fill it in.** One row per offer. Columns: `group_id`, `offer_id`, `name`, `type`, `description`, `monthly_fee`, `upfront_price`, `prices_include_tax`, `contract_months`, `contract_free_months`, `etc_percent`, `subsidy`, `device_retail_price`, `fulfilment`, `stock_skus`, `colours_storage`, `device_contracts`, `channels`, `requires`, `excludes`, `partner_code`, `market`, `status`, `go_live_date`. Amounts are plain numbers in the regional currency (`12.50`). Lists use `|`: `fulfilment` as option ids (`SHIP|SIM`), `colours_storage` as `Colour/Storage/SKU/price difference`, `device_contracts` as `months:subsidy[:free months]` (`24:400|12:200`). Lines starting with `#` are ignored; up to 1,000 offers per file.
3. **The key is `offer_id`.** A row whose id already exists **updates** that offer (a blank cell leaves the field as it is; the group can be changed to move the offer); any other row **creates** one, as a draft unless `status` says `SCHEDULED` (with `go_live_date`, `YYYY-MM-DD`, start of the day in UTC) or `ACTIVE`. With no `offer_id` it is made from the name, so loading the same file again updates the same offers and never duplicates them. An id already used by a group, category or network type is refused.
4. **Check, then load.** The check runs exactly the code the offer form uses (type behaviour, currency, prerequisites, contract and subsidy rules, sold offers cannot be repriced) and then undoes it, so nothing changes. Each row is marked Create/Update and Ready or Problem with the line and the reason. The file loads only if every row is valid, and then all together.

API: `GET /api/catalog-import/template[?offers=1]` and `POST /api/catalog-import` with `{ "csv": "...", "apply": false }` (check) or `true` (load).
