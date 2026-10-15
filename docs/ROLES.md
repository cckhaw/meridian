# Roles and permissions

<!-- GENERATED from packages/core/src/rbac.ts by `pnpm --filter @meridian/core docs:roles`. Do not edit by hand; a test fails if it drifts. -->

The API checks **permissions**, never role names. A user holds one or more **roles**; their permissions are the union. The environment-defined **super user** holds every permission.

**These tables are the defaults.** An administrator can change what each role may do under Users & roles → Roles and permissions (including the credit-note limit); the change applies to everyone holding the role on their next request, is written to the audit log, and **Reset to default** returns the role to what is below. `settings:manage` can never be given to a role, and the Administrator role always keeps `user:manage`. A built-in role’s scope (which records it sees) and landing page are fixed. **New role** creates a role of your own: you name it, choose whether it sees all records or only its own store or dealer, pick its landing page, and tick its permissions (optionally starting from a copy of another role). A role you created can be renamed, changed and deleted (once nobody holds it); the roles below cannot be deleted.

**Scope** decides *which rows* a role can see: `All records`, or only the user’s own `store`, `dealer` or `customer`. A user with any unscoped role sees everything their permissions allow. A scoped role with a missing binding sees nothing (fails closed).

## Summary

| Role | Scope | Landing page | Credit notes up to | Purpose |
|---|---|---|---|---|
| **Administrator** (`admin`) | All records | `/admin/users` | none | Runs the platform: manages users and roles, defines the catalog, reads everything. Cannot take payments or issue credits. |
| **Product Configurator** (`product-configurator`) | All records | `/catalog` | none | Designs the product catalog: offers, prices, contracts, ETC rules, fulfilment. |
| **Billing Operations** (`billing-ops`) | All records | `/billing` | unlimited | Prepares bill runs (mock, review, exclusions) and runs dunning, records payments, issues credit notes, handles invoice queries. Approval of a bill run is for Finance or Revenue Assurance. |
| **Rating & Charging** (`rating-charging`) | All records | `/catalog` | none | Reviews tariffs and price plans (read-only). Usage rating is not part of this release. |
| **Customer (self-serve portal)** (`self-serve`) | Own customer | `/account` | none | An end customer. Sees and acts only on their own account: shop, orders, bills, cases. Online payments are confirmed by the payment provider webhook, never by the customer. |
| **Call Center Agent** (`call-center`) | All records | `/customers` | none | Handles customer queries on the Customer 360: profile, services, orders, bills, cases. Can suspend/resume, change SIM or number, take payments. |
| **Telesales Agent** (`telesales`) | All records | `/orders/new?channel=TELESALES` | none | Sells by phone: creates customers and telesales orders. |
| **Retail Store** (`retail-store`) | Own store | `/orders/new?channel=RETAIL_ASSISTED` | none | Sells over the counter at one store: assisted and quick-sale orders, SIM changes, store stock. Sees only that store’s orders and stock. |
| **Dealer** (`dealer`) | Own dealer | `/orders/new?channel=DEALER` | none | A partner who sells for the operator. Sees only their own orders and commission. |
| **Dealer Desk** (`dealer-desk`) | All records | `/orders/new?channel=DEALER` | none | Operator staff who keep the dealers and their agents and place orders on a dealer’s behalf, naming the dealer and the agent who sold it. |
| **Customer Service** (`customer-service`) | All records | `/cases` | 200.00 | Resolves escalated cases: refunds (up to the credit limit), termination, ownership transfer, number porting, order cancellation. |
| **Finance** (`finance`) | All records | `/finance` | unlimited | Owns the ledger: reconciliation, SAP journal export, large credit notes, receivables, and approval of bill runs. |
| **Fraud Analyst** (`fraud`) | All records | `/orders` | none | Reviews orders and accounts: can suspend a service and cancel an order before it ships. |
| **Revenue Assurance** (`revenue-assurance`) | All records | `/finance` | none | Checks that billing, payments and the ledger agree, and approves a bill run once its mock has been reviewed (otherwise read-only). |
| **KYC Compliance Officer** (`compliance`) | All records | `/kyc` | none | Reviews identity verification for online sign-ups and referred cases: approves, rejects, or sends back for corrections. Sees identity evidence; cannot sell or change billing. |
| **Operations Support** (`inventory-ops`) | All records | `/inventory` | none | Looks after stock: keeps warehouse locations, loads stock in batches or one SKU at a time, and writes stock off with a reason. Sees the stock history; cannot sell or change billing. |

## Modules each role can open

| Module | Administrator | Product Configurator | Billing Operations | Rating & Charging | Customer (self-serve portal) | Call Center Agent | Telesales Agent | Retail Store | Dealer | Dealer Desk | Customer Service | Finance | Fraud Analyst | Revenue Assurance | KYC Compliance Officer | Operations Support |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Overview | ✓ | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Customers | ✓ |  | ✓ |  |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| New order |  |  |  |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| Orders | ✓ |  |  |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |  |  | ✓ |
| Billing | ✓ |  | ✓ |  | ✓ | ✓ |  | ✓ |  |  | ✓ | ✓ |  | ✓ |  |  |
| Cases | ✓ |  | ✓ |  | ✓ | ✓ |  |  |  |  | ✓ |  | ✓ |  | ✓ |  |
| KYC reviews |  |  |  |  |  |  |  |  |  |  |  |  | ✓ |  | ✓ |  |
| Number porting |  |  |  |  |  |  |  |  |  |  | ✓ |  |  |  |  |  |
| Catalog | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  | ✓ |
| Inventory | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  |  |  |  |  | ✓ |
| Numbers & SIMs | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ✓ |
| Finance | ✓ |  |  |  |  |  |  |  |  |  |  | ✓ |  | ✓ |  |  |
| Stores | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Dealers |  |  |  |  |  |  |  |  | ✓ | ✓ |  |  |  |  |  |  |
| Commission | ✓ |  |  |  |  |  |  | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  |
| Users & roles | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Settings |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Integration |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Data migration | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Audit log | ✓ |  |  |  |  |  |  |  |  |  |  |  | ✓ | ✓ | ✓ |  |

## Permission matrix

| Permission | Administrator | Product Configurator | Billing Operations | Rating & Charging | Customer (self-serve portal) | Call Center Agent | Telesales Agent | Retail Store | Dealer | Dealer Desk | Customer Service | Finance | Fraud Analyst | Revenue Assurance | KYC Compliance Officer | Operations Support |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `dashboard:read` | ✓ | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `customer:search` | ✓ |  | ✓ |  |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| `customer:read` | ✓ |  | ✓ |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| `customer:create` |  |  |  |  |  |  | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `customer:write` |  |  |  |  |  | ✓ |  |  |  |  | ✓ |  |  |  |  |  |
| `service:read` | ✓ |  | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |  | ✓ |  |  |  |
| `service:manage` |  |  |  |  |  | ✓ |  | ✓ |  |  | ✓ |  |  |  |  |  |
| `service:suspend` |  |  |  |  |  | ✓ |  |  |  |  | ✓ |  | ✓ |  |  |  |
| `service:terminate` |  |  |  |  |  |  |  |  |  |  | ✓ |  |  |  |  |  |
| `service:transfer` |  |  |  |  |  |  |  |  |  |  | ✓ |  |  |  |  |  |
| `service:self` |  |  |  |  | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `mnp:manage` |  |  |  |  |  |  |  |  |  |  | ✓ |  |  |  |  |  |
| `order:read` | ✓ |  |  |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |  |  | ✓ |
| `order:payment` |  |  |  |  |  | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `order:fulfil` |  |  |  |  |  |  |  | ✓ |  |  |  |  |  |  |  |  |
| `order:cancel` |  |  |  |  | ✓ |  |  | ✓ |  |  | ✓ |  | ✓ |  |  |  |
| `order:override` |  |  |  |  |  |  |  |  |  |  | ✓ |  |  |  |  |  |
| `billing:read` | ✓ |  | ✓ |  | ✓ | ✓ |  | ✓ |  |  | ✓ | ✓ |  | ✓ |  |  |
| `billing:pay` |  |  | ✓ |  |  | ✓ |  | ✓ |  |  |  |  |  |  |  |  |
| `billing:credit` |  |  | ✓ |  |  |  |  |  |  |  | ✓ | ✓ |  |  |  |  |
| `billing:run` |  |  | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `billing:approve` |  |  |  |  |  |  |  |  |  |  |  | ✓ |  | ✓ |  |  |
| `finance:read` | ✓ |  |  |  |  |  |  |  |  |  |  | ✓ |  | ✓ |  |  |
| `finance:export` |  |  |  |  |  |  |  |  |  |  |  | ✓ |  |  |  |  |
| `finance:configure` |  |  |  |  |  |  |  |  |  |  |  | ✓ |  |  |  |  |
| `ledger:ingest` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `catalog:read` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  | ✓ |
| `catalog:write` | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `inventory:read` | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  |  |  |  |  | ✓ |
| `inventory:write` |  |  |  |  |  |  |  | ✓ |  |  |  |  |  |  |  | ✓ |
| `numbering:read` | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ✓ |
| `numbering:select` |  |  |  |  |  | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  | ✓ |
| `numbering:manage` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ✓ |
| `inventory:writeoff` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ✓ |
| `warehouse:manage` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ✓ |
| `case:read` | ✓ |  | ✓ |  | ✓ | ✓ |  |  |  |  | ✓ |  | ✓ |  | ✓ |  |
| `case:create` |  |  | ✓ |  | ✓ | ✓ |  |  |  |  | ✓ |  | ✓ |  |  |  |
| `case:write` |  |  | ✓ |  |  | ✓ |  |  |  |  | ✓ |  | ✓ |  |  |  |
| `commission:read` | ✓ |  |  |  |  |  |  | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  |
| `commission:configure` |  |  |  |  |  |  |  |  |  |  |  | ✓ |  |  |  |  |
| `commission:settle` |  |  |  |  |  |  |  |  |  |  |  | ✓ |  |  |  |  |
| `dealer:read` |  |  |  |  |  |  |  |  | ✓ | ✓ |  |  |  |  |  |  |
| `dealer:manage` |  |  |  |  |  |  |  |  |  | ✓ |  |  |  |  |  |  |
| `store:manage` | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `audit:read` | ✓ |  |  |  |  |  |  |  |  |  |  |  | ✓ | ✓ | ✓ |  |
| `migration:export` | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `migration:import` | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `user:manage` | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `store:assist` |  |  |  |  |  |  |  | ✓ |  |  |  |  |  |  |  |  |
| `kyc:attest` |  |  |  |  |  |  |  | ✓ |  |  |  |  |  |  |  |  |
| `kyc:review` |  |  |  |  |  |  |  |  |  |  |  |  | ✓ |  | ✓ |  |
| `settings:manage` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `order:create:SELF_SERVE` |  |  |  |  | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `order:create:RETAIL_ASSISTED` |  |  |  |  |  |  |  | ✓ |  |  |  |  |  |  |  |  |
| `order:create:QUICK_SALE` |  |  |  |  |  |  |  | ✓ |  |  |  |  |  |  |  |  |
| `order:create:TELESALES` |  |  |  |  |  |  | ✓ |  |  |  |  |  |  |  |  |  |
| `order:create:DEALER` |  |  |  |  |  |  |  |  | ✓ | ✓ |  |  |  |  |  |  |
| `order:create:CALL_CENTER` |  |  |  |  |  | ✓ |  |  |  |  |  |  |  |  |  |  |

## Separation of duties

- Administrators manage users and the catalog but **cannot take payments or issue credit notes**.
- Call-center agents can take payments and change SIM/number but **cannot issue credits or terminate**: they escalate to Customer Service.
- Customer Service can refund up to a limit; Billing Operations and Finance have no limit.
- Only users holding `order:payment` can state that money was received, and in production they must give the terminal approval or receipt number.
- Customers in the self-serve portal can never confirm their own payment; that comes from the payment provider webhook.
- Who sold an order is taken from the signed-in session, never from the request, so commission cannot be forged.
