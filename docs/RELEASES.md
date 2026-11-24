# Catalog releases

Without releases, an edit to an offer is live the moment it is saved. A **release** is a named batch of catalog changes that are **not live** until the release is published: you collect the changes, review what they would do, and publish them together (now, or at a chosen time). **Catalog → Releases**; it needs the catalog-write permission (see [Permissions](#permissions)).

Nothing changes for anyone who does not use releases: with no release selected the Catalog screens save straight to the live catalog exactly as before.

## Working in a release

1. **Releases → New release** gives it a name (it gets a number, `REL-0001`…) and selects it. While a release is selected, a bar on the Catalog screen says so (*Working in REL-0007 · Autumn promotion · 5 changes, not live yet*), and **every save becomes an addition to the release**: the buttons read **Add to release**, and nothing goes live.
2. Edit as usual: add an offer, change its price, fulfilment or rules, move it, retire it, delete it, change its line items, add a group. Forms start from the **staged** state of what you are editing, so a second edit builds on the first.
3. **Review** (the release page) shows each change and what publishing would do. Fix or remove what is wrong.
4. **Publish now**, or **Schedule** a time.

Choose **Stop working in it** at any time to go back to saving straight to the live catalog. A release is picked per browser, not per user.

What goes through a release: creating, changing, moving, retiring/activating/scheduling and deleting any catalog node (network type, category, group, offer, line item), and copying line items for a new version. What does **not**: reordering (it applies at once), the **CSV import/export**, **bundle discounts**, offer types, fulfilment options and every other setting, and the **TMF620** API. Those keep writing straight to the live catalog. (The design leaves room for TMF620 writes to target a release later with the same `?release=<id>` parameter the screens use.)

## What a release holds

Each change is stored as **the same input the existing catalog function takes**: create (`createNode`), update (`updateNode`), move (`moveNode`), status (`setStatus`: activate, retire, schedule), delete (`deleteNode`) and copy line items (`copyLineItems`). **Publishing replays them through those functions**, so every rule of the catalog applies with no second copy of any validation: a sold offer cannot be repriced, a SKU is reserved once, prerequisites must exist and not be circular, the parent must fit, the currency must match Settings.

A release holds at most **500 changes**. A node can be in **one open release at a time**: staging it in a second one is refused and names the first. Staged changes are checked for shape when you save them; the full check (everything the catalog would say) runs on the review page and again when you publish.

## Review: preview and diff

The review page runs every change, in order, **inside a transaction that is rolled back** (the same pattern as the CSV import's check), one savepoint per change, so:

* each change shows whether it **would be refused**, and why, in the catalog's own words; a later change that depended on a refused one reports its own refusal;
* the **diff** is exactly what publishing would do: for each node new / changed / deleted, with before and after for name, status, go-live date, group, type, prices, contract, fulfilment, prerequisites and exclusions, channels, markets, partner code, valid-for days, characteristics, variants, deals, group-plan terms, suspension terms and charging plan; a line item shows under its offer (added, removed, changed);
* a **summary** counts what is added, changed, made live, retired, repriced, moved, deleted and how many line items change.

Nothing is written for real while you review: no node, no event, no audit line.

## Conflicts

Each change remembers the **version** the live node had when it was first staged. If someone edits that node live afterwards, the release page lists it under *Changed underneath this release* (with who and when), and **publishing is blocked** until you either **keep the live change and apply mine on top** (the node is re-based on today's version) or **remove** its changes. A node deleted live, or one the release creates that now exists, is also a conflict; those cannot be accepted, only removed.

## Publishing

Publishing is **one transaction**: the release row is locked, conflicts are checked, every change is applied in order through the catalog functions, and the release is marked published. If **any** change is refused, **nothing is applied** and the message names the change (*Change 3 (UPDATE rel-at-edit) was refused, so nothing was published: …*). One audit entry for the release (`RELEASE_PUBLISHED`, with the summary) is written besides the per-node entries the catalog functions already write. The catalog's own events (`OFFERING_*`, `CATEGORY_*`, [TMF620.md](TMF620.md#events)) are raised in the same transaction, so listeners hear about each node as always.

The state of every touched node **before** publishing is kept with the release (this is what a reverse release is built from).

**Scheduled publishing.** *Schedule* sets a time; the same sweep that activates scheduled offers (it runs on any request, at most every 15 seconds per server) publishes the release when the time comes. It is safe on several servers at once (the release row is locked and its state checked). A node's own *Scheduled* status can only switch a node on; a release schedule can apply any change, so a price change can take effect at a chosen moment. If the scheduled publish cannot happen (a conflict, a refused change) the release stays a draft with the reason shown, and the sweep **does not retry** until you schedule it again or publish it yourself.

## A new version instead of repricing a sold offer

A sold offer's price, contract and type cannot change in place: its subscribers would be repriced. **New version of a sold offer…** on the release page stages the way it is done instead, as **one repriced change**: a new offer with the same terms and the new prices (`<offer>-v2`), the old offer's line items copied to it, the new offer made live and the old one retired **together when the release publishes**, and (unless you untick it) every offer that required, excluded or listed the old one as a group-plan member pointed at the new one (at most 50; more is refused and asks for a separate release). Subscribers stay on the old offer, which is retired, not removed. The diff and the summary show it as one *repriced* change, not an addition and a retirement. An offer that has never been sold is just edited. Bundle discounts that name the old offer are not changed.

## Reversing a published release

**Create a reverse release** on a published release builds a new **draft** release that puts back what it changed, from the saved before-state: edits are reversed, moves and status changes are put back, offers and groups it created are deleted (children first), or retired when they have been sold since or hold something that stays. It is an ordinary release: it is previewed, reviewed and published like any other, and the catalog's rules apply to it, so a sold offer's price that cannot go back in place shows as refused in its preview. Limits: a *valid-for days* value that did not exist before cannot be cleared by the catalog's update, and a reversed release does not undo orders or services that happened in between.

## Permissions

In this phase every release action needs the catalog-write permission, the same as editing the catalog (publishing applies nothing the same people could not already do live). Approval (submit, approve, publish as separate permissions, with the author unable to approve) is the next phase.

## API

`GET/POST /api/catalog/releases`, `GET/PATCH /api/catalog/releases/:id`, `GET …/:id/preview`, `DELETE …/:id/changes/:changeId`, `POST …/:id/publish | schedule {publishAt|null} | cancel | rebase {nodeId} | reprice {offerId, prices, newId?, repointDependents?} | reverse`. Staging reuses the ordinary catalog write routes with **`?release=<id>`**: `POST /catalog`, `PATCH /catalog/:id` (an update and a status change are two changes), `POST /catalog/:id/move`, `DELETE /catalog/:id`, `POST /catalog/:id/line-items/copy-from`; each answers `{ staged: true, release, id, changes }`. `GET /catalog/:id/detail?release=<id>` is a node as the release would leave it. Reordering with `?release=` is refused.

## Scale

Nothing loads the catalog. A release is at most 500 rows; lists of releases are keyset-paged; the preview touches only the nodes the changes name; conflict checks read those nodes by id. Publishing costs what making the same changes one by one costs, in one transaction: the catalog's dependency check reads the requires/excludes graph on every offer write, so a very large release against a very large catalog is as slow as the same edits are today.
