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

An outline on the left (structure down to offers, with search), the selected item on the right. Choosing a network type, category or group lists what it contains; choosing an offer shows what’s included, pricing and rules. The selection is in the address (`/catalog?node=…`), so items can be linked to and Back works. On a phone it is one screen at a time with a Back button. Actions live behind a single **⋯** menu per item; the pencil (**Edit offer**) opens the full offer form.

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
