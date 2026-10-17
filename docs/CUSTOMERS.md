# Customers, segments and groups

## The structure

**Customer → Account → Service.** A customer is a person or a company. Beneath a customer sit one or more accounts (each with its own bill cycle and balance), and beneath each account one or more services (mobile, fibre, IoT, subscriptions). A company can also have departments: customers beneath a customer.

A **Group** is a different dimension. It ties several services *on one account* together so they can share benefits. It is not a kind of customer, and it is not about households: a company can group its staff lines in exactly the same way.

## Segments (Settings → Customers)

Every customer belongs to one segment. To start with: **Consumer**, **Enterprise** and **IoT**. The operator can add more, rename them, and switch them off; segments are never deleted, because customers and history point at them.

- A segment is *individual* or not. In an individual segment (Consumer) there is one customer per ID document, so the same person cannot be added twice. Company and fleet segments may share one.
- Each segment gets a short code from its name when created (`SMALL_BUSINESS`); the code never changes.
- A switched-off segment cannot be chosen for new customers or moves, but the customers already in it stay. At least one segment must stay on. Whether a segment is individual cannot change once it has customers.
- Segments are also available as a condition in the [cancellation rules](ORDERS.md) ("customer segment").

### Moving a customer to another segment

Open the customer and choose **Change segment**. A reason is required; the move, who made it and when are kept (shown as *Segment history* on the customer, and in the audit log). Accounts, services and orders are unchanged. Moving to an individual segment is refused if another customer holds the same ID document, or if the customer has departments or is itself a department.

## Creating customers

A customer normally comes into being with their first order, so the order wizard creates one when needed. **Settings → Customers → "Allow creating a customer from the Customers page"** (off by default) controls whether the Customers page also offers **New customer**. When it is off the button is hidden and the server refuses a standalone create.

### The new-customer form (Settings → Customers and segments, Settings → Bill cycles)

Always asked: **Full name / Company name**, **ID document** (NRIC, passport or business registration), the segment and the bill cycle. For every other detail the administrator chooses **Hidden**, **Optional** or **Required**: e-mail, phone, date of birth, gender, address, postcode, city, state or region, and country. A hidden detail is not shown, not asked and not stored; a required one must be filled in, whether the form is used on the Customers page or in the order wizard (the API enforces it too). Everything starts as optional. The details a customer has are shown under their name on the customer page.

**Bill cycles** are a list in Settings: the days of the month (1 to 28) that a new customer or account can be given (there is no daily cycle), and the default a new account starts with: a **fixed day** chosen from the list, or based on the date the billing account is created, the **next bill cycle date** (the next switched-on day after it) or the **previous bill cycle date** (the latest switched-on day before it). Switching a cycle off removes it from the drop-down and from the API; accounts already on it keep it.

The online shop keeps the date of birth and address a shopper gave for identity verification on the customer it creates.

## Groups

Find them on the account (Customers → customer → account → **Groups**). Staff with `service:manage` can create and change them.

- A group holds services of **one account**. A service is in at most one group.
- Exactly one service is the **Principal**; the rest are **Supplementary**. A supplementary service cannot exist without the principal.
- The principal cannot leave while supplementary services remain: make another service the principal first, or dissolve the group. A group whose last member leaves closes. **Adding a member:** an existing free line on the account can be added from the group, or **Sell a new line** opens the order wizard for the customer with the group chosen and the group plan's member plan preselected; the new line joins when the order is placed. **Dissolving** asks for a single-line plan for every line that is on the group plan or on a plan reserved for members (the family head always); other lines keep their plan unless another is chosen. Numbers, SIMs and history stay; the new plan's fee applies from the next bill run (`POST /groups/:id/dissolve` with `{ plans: { serviceId: offerId } }`). Terminating or transferring a supplementary service simply removes it from the group; terminating or transferring a principal that still has supplementary services is refused until it is handed over.
- **Shared benefits** are set per group: shared data (GB), voice (minutes) and SMS, and a percentage discount on the recurring fee of every supplementary service. The discount is applied as a line on each bill (pro-rated for part periods). The shared allowances are recorded on the group; usage rating is not part of this release, so they are not metered.

A group made for a **group plan** also has a place limit and allowed member plans, and is created by an order or a plan change rather than by hand: see [FAMILY_PLANS.md](FAMILY_PLANS.md).

## Services over time

A service can be suspended at the customer's request (for example when travelling, for up to six months, keeping its number), restricted for a credit limit or unpaid bills, terminated, or ported out. The rules, who may do what and what it costs are in [LIFECYCLE.md](LIFECYCLE.md). An account can have its own **credit limit** and a **deposit** held for it; both appear in that document.

## Dealers

Dealer ids are issued by the system (`DLR-00001`, …) and cannot be edited; see [Operations](OPERATIONS.md).
