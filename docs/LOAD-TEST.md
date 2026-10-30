# Load test data generator

`scripts/load-test/run.mjs` drives the real API (the same calls the screens make) to fill a system with realistic, varied data so every module has something to review. `scripts/load-test/load-pools.mjs` tops up the phone numbers, IMSIs, SIM cards and eSIM profiles it consumes. Both are plain Node 20+ (no packages); `scripts/load-test/lib.mjs` holds the shared pieces (retry, governor, planners) and `node --test scripts/load-test/lib.test.mjs` checks them.

## Run it

```bash
export BASE=https://meridian.example.com ADMIN_USER=<admin> ADMIN_PASS='<password>'   # ADMIN_OTP=<code> if the admin has a second factor
node scripts/load-test/run.mjs --dry --orders 20000          # read-only: which offers can be sold, which stores and dealers exist, how much stock there is
node scripts/load-test/run.mjs --customers 10                # start small
node scripts/load-test/run.mjs --customers 80
```

Options (all optional):

| Option | Meaning |
| --- | --- |
| `--customers N` (60) | new customers (about 15% companies), with camera-style ID photos |
| `--orders N` | orders to place; about 2.2 x customers when customers are made in the same run, otherwise 0. With adopted customers it means N **more** orders |
| `--cases N`, `--interactions N` | default: 0.3 x customers (at most 3,000) and 1.2 x customers |
| `--phases a,b,c` | which phases to run (below); default all |
| `--resume` | shortcut for every phase except `setup`, `customers`, `kyc` |
| `--concurrency N` (6, at most 12) | calls in flight; a governor lowers it automatically when calls fail |
| `--tag LT`, `--seed N`, `--keep-users`, `--out FILE` | tag for everything created, repeatable randomness, keep the staff logins active, report path |
| `--dealers N` (3), `--agents-per-dealer N` (2), `--stores N` (0), `--callcentre N`, `--telesales N`, `--backoffice N` | new dealers, stores and staff accounts (staff get passwords nobody knows; an admin can reset any) |
| `--esim-share 0.35` | share of plan lines sold with an eSIM where a physical card is also available |
| `--quicksale-stores N` (5) | stores that get a counter login for QUICK_SALE orders (outright goods only) |
| `--groups N` | family (group plan) orders, default about 1.5% of verified customers, at most 150 |
| `--bill-chunk N` (500) | accounts per selective bill run (the API takes up to 10,000) |
| `--cycle-run` | also run the bill cycle day that has most load-test accounts. **It bills every active account on that cycle day, not only the load-test ones.** Off by default |
| `--immediate-share 0.5` | share of plan changes that take effect at once; those leave a negative pro-rating line on the next invoice (see Known issues) |
| `--dry` | read-only |

## Phases

`setup` (dealers, stores, staff), `customers`, `kyc` (identity reviews: most approved, some rejected, some sent back, some left waiting), `orders`, `changes` (suspend, resume, plan change, group move, termination, family group orders), `care` (interactions, cases), `billing`, `payments` (payments, part payments, credit notes, refunds), `ops` (dunning, collections, fraud scan and alerts, blacklist), `report`.

A phase that needs customers and does not create them **adopts** the ones already tagged: it pages through `/customers` (100 per page, in sequence) and keeps names ending in `[TAG]`, then reads each customer's services, accounts, KYC state and order history in parallel. That makes any phase repeatable on its own, and it is how you carry on after an interruption (below). The staff logins the phases need (`lt.compliance`, `lt.finance`, `lt.agent.1` to `lt.agent.5`) are created or reset whenever a phase needs them and disabled at the end unless `--keep-users`.

## What the order phase does

* Reads the whole catalog (all pages) and **quotes** every sellable offer to learn which baskets work: alone, with a plan or device it requires (add-ons, device care), as a device on a contract attached to a plan (financed, and paid in full), group plans with member lines. It prints any offer that cannot be quoted, with the reason.
* Reads every active store (paged) and every dealer with its agents, the number pool (`/numbering/summary`), SKU stock per location (`/inventory`) and the free physical SIMs at each store.
* Spreads orders over **all** channels that work with a staff session: CALL_CENTER, TELESALES, RETAIL_ASSISTED, DEALER, and QUICK_SALE (counter sale of outright goods; needs a store login, so a few stores get one; SELF_SERVE belongs to the store-front and is refused for staff).
* Every store and every dealer agent is visited at least once (a coverage list is worked first), then orders are spread by least-used plus chance. Every sellable offer is picked in about half of the orders by lowest count, so each range sells; the rest follow a realistic mix.
* Customers get a weighted number of orders (most 2 to 6, some 10 or more, some 1). About 7% of orders go to customers whose identity check is still waiting; those orders wait on the check ("held").
* Baskets are chosen where the stock is: a store without SIM cards sells eSIM plans, fibre and add-ons; goods and devices are only sold where that store (or the warehouse, for remote channels) holds the SKU; the colour/storage with stock is chosen.
* It learns from refusals: an offer that cannot be sold alone, a SKU that ran out at a place, no SIMs in a store or warehouse, no eSIM profiles, no numbers left. It stops picking that product or place (and says so in the log and report) and keeps going. Repeated unexplained refusals pause the offer for a few minutes instead of hammering it.
* Stops at `--orders` successes or when attempts pass 1.6 x that. Orders carry one idempotency key for all their retries, so a timeout can never make two orders; "repeats answered from the idempotency key" in the log counts the retries that found the first one had worked.
* About 15% of the orders that are still waiting (not live yet) are cancelled to fill the cancellation lists.

At the end it prints a table of orders per offer (flagging any offer that never sold with its first refusal), orders per channel, and the stores and dealers with the most and fewest orders (and how many got none).

## Resilience

* Every call goes through one session with retry: network errors, 429, 502, 503, 504 and 500s that are plainly infrastructure timeouts are retried up to 5 times with exponential backoff and jitter, honouring `Retry-After`. A write is retried blindly only if it carries an idempotency key (orders, payments) or cannot have been processed (the connection never opened, or 429). Everything else that fails is counted and reported, never repeated.
* A governor watches the last 50 calls; if more than 20% failed for infrastructure reasons it halves the calls in flight (down to 2) for a minute, then recovers.
* Per-record work (services, changes, interactions, cases and their assign/note/status steps, invoices, payments, credits, refunds, collections) runs through the worker pool at `--concurrency`.
* A progress line is printed at most every 30 seconds (phase, done/total, calls per second, error rate, concurrency); the JSON report (`load-test-report-<TAG>.json`) is rewritten every minute and at the end, with per-step ok/failed counts, the first 5 distinct errors per step, per-offer, per-store, per-dealer and per-agent order counts, stock figures, billing runs and timings per phase. Ctrl-C writes the report before exiting. Nothing secret is printed.
* A session is signed in again if it expires (12 hours by default). An admin who used a one-time code cannot be signed in again: stage a very long run in phases (below).

## Scale guidance: 5,000 customers and 20,000 orders

Stock first. The run uses a phone number for every mobile line, an IMSI for every SIM and eSIM, a physical card or an eSIM profile per line, and device stock.

* Plan lines are about 1.3 x orders x 0.8 = 21,000. Standard numbers: at least 22,000 (VIP-pattern numbers do not count, about 3% of any range). Physical cards and eSIM profiles split by `--esim-share`, and stores without cards sell eSIM only; with the stores that exist today plan for roughly 8,000 cards in WH-MAIN and 12,000 eSIM profiles. IMSIs: one per card and per profile (the loader adds them).
* `run.mjs` prints the estimate, compares it with what is free, and warns in capitals when stock is short. Devices and goods are limited by the SKU stock of each store and of WH-MAIN; the run reports what ran out. Top up with `inventory` imports if needed.

```bash
node scripts/load-test/load-pools.mjs --msisdn 24000 --sims 8000 --esims 12000 --batch LT-POOLS --dry   # check the ranges first
node scripts/load-test/load-pools.mjs --msisdn 24000 --sims 8000 --esims 12000 --batch LT-POOLS
```

`load-pools.mjs` finds the highest value already in each pool (by probing the listing one digit at a time), starts above it, checks every chunk with the importer's own check (`apply: false`: conflicts move the range up) and loads in chunks inside the 4 MB and 200,000 limits. Options: `--msisdn N`, `--sims N` (physical, in `--location`, default WH-MAIN, each bound to a freshly loaded IMSI), `--esims N`, `--imsi N` (extra IMSIs; by default exactly enough for the cards and profiles), `--batch NAME` (every batch carries the name), `--dry`, `--chunk N`. It prints a before/after of `/numbering/summary`. Numbers use the dial code and shape of the sample template (`/numbering/template/msisdn`), ICCIDs start `8960118763890000000` when the pool is empty.

Staged run (each stage can be repeated or resumed by itself; use the same `--tag`):

```bash
T="--tag LT --concurrency 12"
node scripts/load-test/run.mjs $T --phases setup,customers,kyc --customers 5000 --dealers 300 --stores 150 --callcentre 100 --telesales 30 --backoffice 15
node scripts/load-test/run.mjs $T --phases orders --orders 20000
node scripts/load-test/run.mjs $T --phases changes,care --cases 1500 --interactions 6000
node scripts/load-test/run.mjs $T --phases billing,payments,ops
```

Expected time depends on how fast the server answers; the script cannot go faster than the database. Measured on a laptop with the embedded database (single connection) at concurrency 8: about 5 customers per second, 2.5 orders per second (20,000 orders would take over two hours there), 8 to 12 care records per second. A production database should do several times better; as a guide at concurrency 12 and 300 ms per call expect customers 15 to 25 minutes for 5,000 (a photo upload each), orders 10 to 40 minutes for 20,000, changes and care 15 to 30 minutes, billing 10 to 20 minutes (10 runs of 500 accounts, each waits for its work slices), payments 10 to 20 minutes. Watch the progress line: if "calls/s" is far below concurrency / latency the server is the limit; if the error rate rises the governor slows the run by itself.

## After an interruption

Stop (Ctrl-C) or crash: the report holds what was done. Run the remaining phases with the same tag; they adopt what exists:

* during `customers`: run `--phases customers --customers <remaining>` (the count is of new customers; check the report's `customers.created`), then `kyc`;
* during `kyc`: `--phases kyc` again (it reviews the customers still waiting; some stay waiting by design);
* during `orders`: `--phases orders --orders <remaining>`: the count is N **more** orders, read from the report (`orders.ok`);
* during `changes`, `care`, `billing`, `payments`, `ops`: run that phase again. `changes` aims for a fixed share of changed services and counts the ones already changed; `care` adds `--cases`/`--interactions` more; `billing` makes new selective runs for the same accounts (run it once per day of data you want); `payments` only touches invoices that still have a balance.

`--resume --tag <TAG>` is the old shortcut: every phase except setup, customers and kyc.

## Known issues found by the load test

* An invoice that carries a **negative pro-rating line** (an immediate plan change in the billing period) fails to post to the general ledger: `gl_entries_credit_minor_check1` (a negative amount is posted as a credit instead of a debit in `createInvoice`, `packages/core/src/billing.ts`). About 2% of the accounts in a bill run were affected when 45% of customers had a service change. Use `--immediate-share 0` to avoid it, or fix `billing.ts` to post a negative per-stream total as a debit.
* List endpoints cap a page at 100 rows (stores, dealers, customers, orders, invoices, cases), so `limit=200` still gives 100; the script follows the cursor either way. The selective bill-run limit is 10,000 accounts (`core.SELECTIVE_MAX`), the script uses 500 per run so each run's work slices stay short.
* Dealer orders take physical SIM cards from the warehouses and goods from WH-MAIN (a dealer does not hold stock of its own), and retail orders take cards and goods from the selling store; a store with no cards sells eSIM plans, fibre and add-ons.

## Finding and removing the data

Customer names end in `[LT]`, ID numbers and dealer names contain the tag, and staff users are `lt.*`. Nothing is deleted by the script. It uses real stock (SIMs, devices) and real numbers, creates dealers, stores and users, places orders at every existing store and dealer, and runs bill runs, so use a test or demo environment where possible. The script drives the live API, so it cannot backdate orders or build months of history.
