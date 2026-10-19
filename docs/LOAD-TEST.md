# Load test data generator

`scripts/load-test/run.mjs` drives the real API (the same calls the screens make) to fill a system with realistic, varied data so every module has something to review.

## Run it

```bash
BASE=https://meridian.khaw.cc ADMIN_USER=<admin> ADMIN_PASS='<password>' \
  node scripts/load-test/run.mjs --customers 10      # start small
BASE=... ADMIN_USER=... ADMIN_PASS=... node scripts/load-test/run.mjs --customers 80
```

Needs Node 20+. If the admin has a second factor, add `ADMIN_OTP=<code>`. Options: `--customers N` (default 60), `--tag LT`, `--seed N` (repeatable run), `--dry` (read-only: checks sign-in and which offers can be sold), `--keep-users`.

Scale options: `--dealers N` (default 3, each with 2 agents), `--stores N` (new stores, each with a store user), `--callcentre N`, `--telesales N`, `--backoffice N` (staff accounts with passwords nobody knows, left active; an admin can reset any), `--concurrency N` (default 4). New stores hold no SIM cards, so retail orders that need a SIM are sold from a store that has stock. Example: `--customers 2000 --dealers 300 --stores 150 --callcentre 100 --telesales 30 --backoffice 15 --concurrency 6` (about an hour). The script drives the live API, so it cannot backdate orders or build months of history.

## What it does

1. Reads your catalog and keeps only offers that can be quoted for sale (plans, devices, fibre, goods, group plans).
2. Creates 3 dealers with 2 agents each, and three temporary staff users (`lt.compliance`, `lt.finance`, `lt.agent`) so approvals use different people. They are disabled at the end unless `--keep-users`.

Scale options: `--dealers N` (default 3, each with 2 agents), `--stores N` (new stores, each with a store user), `--callcentre N`, `--telesales N`, `--backoffice N` (staff accounts with passwords nobody knows, left active; an admin can reset any), `--concurrency N` (default 4). New stores hold no SIM cards, so retail orders that need a SIM are sold from a store that has stock. Example: `--customers 2000 --dealers 300 --stores 150 --callcentre 100 --telesales 30 --backoffice 15 --concurrency 6` (about an hour). The script drives the live API, so it cannot backdate orders or build months of history.
3. Creates customers (about 15% companies) with camera-style ID photos, and runs the KYC queue: most approved, some rejected, some sent back, some left waiting.
4. Places orders on call centre, telesales, assisted retail and dealer channels, some cancelled.
5. Changes live services: suspend/resume, voluntary suspension, plan change, move to a group plan, termination; builds family groups.
6. Logs interactions and opens cases (assigned, noted, moved through statuses), including cases made from interactions.
7. Runs a selective bill run for the load-test accounts (submitted by admin, approved by the finance user), then pays invoices in full or part, issues credit notes, requests and decides refunds.
8. Runs dunning and collections, a fraud scan, raises fraud alerts, adds blacklist entries.

Failures are counted per step and the first examples printed, so a missing stock item (for example no eSIM profiles) doesn't stop the run. A summary is written to `load-test-report-<TAG>.json`.

## Finding and removing the data

Customer names end in `[LT]`, ID numbers and dealer names contain the tag, and staff users are `lt.*`. Nothing is deleted by the script. It uses real stock (SIMs, devices) and real numbers, and creates dealers and users, so use a test or demo environment where possible.

`--resume --tag <TAG>` finishes an interrupted run: it adopts the customers already tagged, skips creating and ordering, and runs interactions, cases, billing, payments, collections and fraud. Interactions and cases may repeat for customers the first run had reached.
