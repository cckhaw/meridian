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

## Groups

Find them on the account (Customers → customer → account → **Groups**). Staff with `service:manage` can create and change them.

- A group holds services of **one account**. A service is in at most one group.
- Exactly one service is the **Principal**; the rest are **Supplementary**. A supplementary service cannot exist without the principal.
- The principal cannot leave while supplementary services remain: make another service the principal first, or dissolve the group. A group whose last member leaves closes. Terminating or transferring a supplementary service simply removes it from the group; terminating or transferring a principal that still has supplementary services is refused until it is handed over.
- **Shared benefits** are set per group: shared data (GB), voice (minutes) and SMS, and a percentage discount on the recurring fee of every supplementary service. The discount is applied as a line on each bill (pro-rated for part periods). The shared allowances are recorded on the group; usage rating is not part of this release, so they are not metered.

## Dealers

Dealer ids are issued by the system (`DLR-00001`, …) and cannot be edited; see [Operations](OPERATIONS.md).
