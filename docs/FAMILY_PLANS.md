# Group plans, family lines and number porting (port-in)

## Group plans in the catalog

An offer becomes a **group plan** (a family plan, a multi-line share) in the offer wizard, on the *Rules* step: "This is a group plan". Only a mobile service plan can be one. The terms are stored on the offer:

| Setting | Meaning |
| --- | --- |
| `isGroupOffer` | the plan opens a group when it is sold |
| `maxGroupMembers` | the supplementary lines it holds besides the family head (1 to 20) |
| `allowedMemberOfferIds` | the plans a member line may take. Empty: any ordinary mobile plan. A group plan can never be a member plan |
| `sharedPoolQuotaGb` | the data pool the group shares. It is recorded on the group (usage is not metered in this release) |

Terms are checked when the offer is saved (limits, and that every named member plan exists and is an ordinary offer). A seeded example: *Family Plan 100GB (shared)* with up to 3 members on *Family Member line*.

## How a group is created

A group normally comes from one of two moments (A and B below). Staff can also make one by hand: on a customer's account, **New group** groups the customer's lines without a group plan (the group is marked as made by hand).

**A. The order (checkout).** In the new-order wizard, adding a group plan adds a **Family members** step. The buyer's own line is the **family head** (the group's Principal; the group lives on the buyer's account). Each member line has its own plan, SIM (next free card, eSIM or later) and number: assigned from the pool, chosen, or **ported in**. The server refuses more members than `maxGroupMembers` and plans the group plan does not allow, in the quote and in the order. When the order activates, the group is created with the head as Principal and the members join it, so the whole family is made in one atomic order. The API takes the same shape: a line with `members: [...]` (see below).

**B. A plan change.** On an existing single line (customer → services → Manage → **Move to a group plan**, or `POST /api/services/:id/upgrade-to-group { offerId }`) the line moves to a group plan and becomes the family head of a new group, keeping its number, SIM and history. The plan's free places stay open (for example 3 of 3). The new plan's fee is billed from the next bill run, because bills are drawn from the catalog.

**Adding members later.** An order line with `joinGroupId` adds a member to an existing group (self-serve or in store); staff can also add a service to the group by hand. Both obey the free places and the allowed member plans. A group created from a plan reports its `slots` (`max`, `used`, `remaining`).

In the data model: `service_groups` is the customer group (linked to the account, with the plan, limit and origin `CHECKOUT` / `PLAN_CHANGE` / `MANUAL`), `service_group_members` maps services to it, and the **Principal** member is the family head.

## Number porting into the operator (port-in)

Any line, on a single plan or a family plan, can bring a number from another operator. The line carries `portIn { donorOperatorId, donorMsisdn, holderName, holderIdType, holderIdNumber, temporaryNumber }`. The donor number starts with the country code and needs no `+`. The donor operator is chosen from a **drop-down**, not typed: the list, with each operator's **operator ID** (its identifier in mobile number portability, MNP), is kept by the super user in **Settings → Back office → Donor operators** (`GET/POST/PATCH/DELETE /api/settings/donor-operators`; sellers read the active ones). A request keeps the operator's name and operator ID as they were when it was raised, and both go to the clearinghouse with it. An operator that was used is switched off rather than deleted. The demo data has five sample operators with placeholder operator IDs: replace them with the real MNP operator IDs of your market.

- **With a temporary number** (the usual choice): the NRM gives the line a Standard number from the pool at once, so it works while the port is processed. The member and the group link to that number first.
- **Without one**: the service waits `PENDING` (it is already in the group) and starts when the number arrives.
- A request is raised for the line (Number porting → **Port-in**). It goes to the national clearinghouse. When the donor **approves**, the switch-over runs: the service takes the ported number, the network is told to swap it (`MSISDN_SWAP`, or `ACTIVATE_PORTED_IN` for a line that waited), and the temporary number goes to rest. The service id never changes, so the plan, the group, its shared quota, discounts, contract and billing carry on untouched.
- **Refused**: a line with a temporary number keeps it as its own number; a waiting line stays pending for staff to decide. **No answer** within the days set in Settings → Numbers & SIMs (default 14): the request expires the same way. A request can also be cancelled.
- A number can have only one live request, and a number that is one of ours or already in service cannot be ported in.

The clearinghouse's answer arrives at `POST /api/mnp/port-in/:id/decision { approved, reference, reason, effectiveAt, complete }` (repeating it changes nothing); `POST /api/mnp/port-in/:id/complete` does the switch-over when `complete` was not sent. `GET /api/mnp/port-in` lists requests. All need `mnp:manage`.

### The Temporal workflow

`portInWorkflow` (services/order-service, workflow id `port-in-<id>`) files the request, waits durably for the donor's answer (the `portDecision` signal), waits for an agreed switch-over date, swaps the number on the HLR/HSS, then asks the CRM to complete, and publishes `meridian.mnp.events`. If the swap keeps failing it ends `NEEDS_ATTENTION` and the CRM is left unchanged. Start it with `POST /meridian-api/port-in/start`; the callback is `POST /meridian-api/port-in/:id/decision`. Its activities are **stubs** until they are wired to the clearinghouse, the HLR/HSS and the CRM endpoints named in `activities/port-in.ts`. The CRM also writes the network and notification instructions to the lifecycle outbox (`PORT_IN_REQUEST`, `MSISDN_SWAP`, `ACTIVATE_PORTED_IN`, `PORT_IN_COMPLETE`, …), so a deployment can deliver them from there instead.

## The order API

`POST /api/orders/quote` and `POST /api/orders` take, on a line:

```json
{ "offerId": "plan-family-100", "simType": "ESIM",
  "members": [
    { "offerId": "plan-family-member", "simType": "ESIM" },
    { "offerId": "plan-family-member", "portIn": { "donorOperatorId": "<operator id>", "donorMsisdn": "60128123456", "holderName": "A. Rahman", "holderIdType": "NATIONAL_ID", "holderIdNumber": "S1234567D", "temporaryNumber": true } } ] }
```

plus `joinGroupId` on a line to join an existing group, and `portIn` on any line. The quote lists the head and then its members (`groupPlan`, `memberOf`, `portIn`).

## Not built yet

The self-serve store-front cart does not offer family members or port-in (the API and the CRM wizard do). Shared-pool usage is recorded, not metered. A ported-in number that is later terminated follows the normal cooling-off and returns to the pool rather than to the donor.
