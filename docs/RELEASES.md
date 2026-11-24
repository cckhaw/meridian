# Catalog releases

Without releases, an edit to an offer is live the moment it is saved. A **release** is a named batch of catalog changes that are **not live** until the release is published: you collect the changes, **a second person reviews and approves them**, and they are published together (now, or at a chosen time). **Catalog → Releases** ([Permissions](#permissions)).

Nothing changes for anyone who does not use releases: with no release selected the Catalog screens save straight to the live catalog exactly as before.

## Working in a release

1. **Releases → New release** gives it a name (it gets a number, `REL-0001`…) and selects it. While a release is selected, a bar on the Catalog screen says so (*Working in REL-0007 · Autumn promotion · 5 changes, not live yet*), and **every save becomes an addition to the release**: the buttons read **Add to release**, and nothing goes live.
2. Edit as usual: add an offer, change its price, fulfilment or rules, move it, retire it, delete it, change its line items, add a group. Forms start from the **staged** state of what you are editing, so a second edit builds on the first.
3. **Check** the release page: each change and what publishing would do. Fix or remove what is wrong.
4. **Send for review**. Someone else [approves it or asks for changes](#approval).
5. Once approved, **publish now**, or **schedule** a time.

The review page, the diff and the conversation are the same for everyone involved. Choose **Stop working in it** at any time to go back to saving straight to the live catalog. A release is picked per browser, not per user.

What goes through a release: creating, changing, moving, retiring/activating/scheduling and deleting any catalog node (network type, category, group, offer, line item), and copying line items for a new version. What does **not**: reordering (it applies at once), the **CSV import/export**, **bundle discounts**, offer types, fulfilment options and every other setting, and the **TMF620** API. Those keep writing straight to the live catalog. (The design leaves room for TMF620 writes to target a release later with the same `?release=<id>` parameter the screens use.)

## What a release holds

Each change is stored as **the same input the existing catalog function takes**: create (`createNode`), update (`updateNode`), move (`moveNode`), status (`setStatus`: activate, retire, schedule), delete (`deleteNode`) and copy line items (`copyLineItems`). **Publishing replays them through those functions**, so every rule of the catalog applies with no second copy of any validation: a sold offer cannot be repriced, a SKU is reserved once, prerequisites must exist and not be circular, the parent must fit, the currency must match Settings.

A release holds at most **500 changes**. Making changes needs `catalog:write` (staging is a catalog edit). A node can be in **one open release at a time**: staging it in a second one is refused and names the first. Staged changes are checked for shape when you save them; the full check (everything the catalog would say) runs on the review page and again when you publish.

## Approval

A release moves **Draft → In review → Approved → Published** (or is *sent back*, or *thrown away*):

| State | What it means | Who moves it on |
|---|---|---|
| **Draft** | changes can still be added, changed and removed | **Send for review** (`release:submit`): only when every change would be accepted and nothing moved underneath it, so a reviewer is never given something that cannot be published |
| **In review** | frozen: nothing can be added or removed | **Approve** or **Ask for changes** (`release:approve`); or the release is taken back to a draft |
| **Approved** | frozen, ready | **Publish now** or **Schedule** (`release:publish`); or approval is taken back |
| **Sent back** (rejected) | the reviewer's reason is in the comments | **Reopen** to a draft, change it, send it again |
| **Published** | live; kept with its diff and what it replaced | **Create a reverse release** |
| **Thrown away** | nothing went live; its nodes are free again | |

**A second pair of eyes.** Nobody who **started a release or made a change in it** can approve it or send it back, whatever else they may do: the server refuses (*You started this release, so someone else has to review it* / *You made changes in this release, so someone else has to review it*). The release page tells each person whether they may review it. Approval re-checks that the release still applies cleanly: one that stopped doing so while it waited (a live edit got in first) cannot be approved, only sent back. **Only an approved release can be published or scheduled**; taking approval back (or reopening) clears its schedule and it has to be approved again.

**Comments.** Every release has a conversation: reviewers' comments, and one entry for each step (sent for review, approved, asked for changes with the reason, reopened, published) with who and when. Anyone involved can comment at any stage. The reason is required when asking for changes.

**Audit and events.** Each step is in the audit log (`RELEASE_SUBMITTED`, `RELEASE_APPROVED`, `RELEASE_REJECTED`, `RELEASE_REOPENED`, `RELEASE_COMMENTED`, `RELEASE_PUBLISHED`). Submitting, approving, sending back and publishing also raise events through the event hub, so webhooks and TM Forum 688 listeners can follow a release: `CatalogReleaseSubmittedEvent`, `CatalogReleaseApprovedEvent`, `CatalogReleaseRejectedEvent`, `CatalogReleasePublishedEvent` ([INTEGRATION_API.md](INTEGRATION_API.md#events)). The body is the standard envelope with `event.catalogRelease` (`id`, `number`, `name`, `lifecycleStatus`, `changeCount`, `by`, and the `summary` or the `reason`).

## Review: preview and diff

The review page runs every change, in order, **inside a transaction that is rolled back** (the same pattern as the CSV import's check), one savepoint per change, so:

* each change shows whether it **would be refused**, and why, in the catalog's own words; a later change that depended on a refused one reports its own refusal;
* the **diff** is exactly what publishing would do: for each node new / changed / deleted, with before and after for name, status, go-live date, group, type, prices, contract, fulfilment, prerequisites and exclusions, channels, markets, partner code, valid-for days, characteristics, variants, deals, group-plan terms, suspension terms and charging plan; a line item shows under its offer (added, removed, changed);
* a **summary** counts what is added, changed, made live, retired, repriced, moved, deleted and how many line items change.

Nothing is written for real while you review: no node, no event, no audit line.

## Conflicts

Each change remembers the **version** the live node had when it was first staged. If someone edits that node live afterwards, the release page lists it under *Changed underneath this release* (with who and when), and **publishing is blocked** until you either **keep the live change and apply mine on top** (the node is re-based on today's version) or **remove** its changes. A node deleted live, or one the release creates that now exists, is also a conflict; those cannot be accepted, only removed.

## Publishing

Publishing (of an **approved** release) is **one transaction**: the release row is locked, conflicts are checked, every change is applied in order through the catalog functions, and the release is marked published. If **any** change is refused, **nothing is applied** and the message names the change (*Change 3 (UPDATE rel-at-edit) was refused, so nothing was published: …*). One audit entry for the release (`RELEASE_PUBLISHED`, with the summary) is written besides the per-node entries the catalog functions already write. The catalog's own events (`OFFERING_*`, `CATEGORY_*`, [TMF620.md](TMF620.md#events)) are raised in the same transaction, so listeners hear about each node as always.

The state of every touched node **before** publishing is kept with the release (this is what a reverse release is built from).

**Scheduled publishing.** *Schedule* (on an approved release) sets a time; the same sweep that activates scheduled offers (it runs on any request, at most every 15 seconds per server) publishes the release when the time comes. It is safe on several servers at once (the release row is locked and its state checked). A node's own *Scheduled* status can only switch a node on; a release schedule can apply any change, so a price change can take effect at a chosen moment. If the scheduled publish cannot happen (a conflict, a refused change) the release stays approved with the reason shown, and the sweep **does not retry** until you schedule it again or publish it yourself.

## A new version instead of repricing a sold offer

A sold offer's price, contract and type cannot change in place: its subscribers would be repriced. **New version of a sold offer…** on the release page stages the way it is done instead, as **one repriced change**: a new offer with the same terms and the new prices (`<offer>-v2`), the old offer's line items copied to it, the new offer made live and the old one retired **together when the release publishes**, and (unless you untick it) every offer that required, excluded or listed the old one as a group-plan member pointed at the new one (at most 50; more is refused and asks for a separate release). Subscribers stay on the old offer, which is retired, not removed. The diff and the summary show it as one *repriced* change, not an addition and a retirement. An offer that has never been sold is just edited. Bundle discounts that name the old offer are not changed.

## Reversing a published release

**Create a reverse release** on a published release builds a new **draft** release that puts back what it changed, from the saved before-state: edits are reversed, moves and status changes are put back, offers and groups it created are deleted (children first), or retired when they have been sold since or hold something that stays. It is an ordinary release: it is previewed, reviewed and published like any other, and the catalog's rules apply to it, so a sold offer's price that cannot go back in place shows as refused in its preview. Limits: a *valid-for days* value that did not exist before cannot be cleared by the catalog's update, and a reversed release does not undo orders or services that happened in between.

## Permissions

| Permission | Lets you | Built-in roles |
|---|---|---|
| `catalog:write` | prepare a release: create it, add and remove changes, accept a live change, throw it away, create a reverse release, start a new version of a sold offer | Administrator, Product Configurator |
| `release:submit` (`catalog:release:submit`) | send a draft for review | Product Configurator, Administrator |
| `release:approve` (`catalog:release:approve`) | approve a release in review or ask for changes; never one you started or changed | Rating & Charging, Administrator |
| `release:publish` (`catalog:release:publish`) | publish an approved release now, or schedule it | Administrator |

Anyone who holds any of the four can **see** releases, their diff and their conversation, and comment; a seller or anyone else with only `catalog:read` cannot. Reopening a release (taking it back to a draft, or taking approval back) needs `catalog:write`, `release:approve` or `release:publish`. The defaults are in the role table in [ROLES.md](ROLES.md) and can be changed there like any other permission. A deployment with a single administrator can prepare a release but needs a second person to review it: that is the point of the rule, and there is no setting to switch it off.

## API

`GET/POST /api/catalog/releases`, `GET/PATCH /api/catalog/releases/:id` (with the changes, conflicts, comments and `review.blocker`: why *you* may not review it, or null), `GET …/:id/preview` (the diff; `ready` can be sent for review, `canPublish` is ready and approved), `DELETE …/:id/changes/:changeId`, `POST …/:id/submit {note?} | approve {note?} | reject {reason} | reopen {note?} | comments {body} | publish | schedule {publishAt|null} | cancel | rebase {nodeId} | reprice {offerId, prices, newId?, repointDependents?} | reverse`. Staging reuses the ordinary catalog write routes with **`?release=<id>`**: `POST /catalog`, `PATCH /catalog/:id` (an update and a status change are two changes), `POST /catalog/:id/move`, `DELETE /catalog/:id`, `POST /catalog/:id/line-items/copy-from`; each answers `{ staged: true, release, id, changes }`. `GET /catalog/:id/detail?release=<id>` is a node as the release would leave it. Reordering with `?release=` is refused.

## Scale

Nothing loads the catalog. A release is at most 500 rows; lists of releases are keyset-paged; the preview touches only the nodes the changes name; conflict checks read those nodes by id. Publishing costs what making the same changes one by one costs, in one transaction: the catalog's dependency check reads the requires/excludes graph on every offer write, so a very large release against a very large catalog is as slow as the same edits are today.
