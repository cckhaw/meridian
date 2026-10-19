# Role permission test

`scripts/rbac-test/run.mjs` checks that every built-in role can do what its permissions say, and nothing else.

```bash
BASE=https://meridian.khaw.cc ADMIN_USER=<admin> ADMIN_PASS='<password>' node scripts/rbac-test/run.mjs --tag RB
```

Options: `--keep-users`, `--no-transactions`. It creates one user per role (`rb.<role>.<tag>`, random passwords, disabled at the end) and a few tagged customers, orders, cases and fraud entries. Needs an administrator.

1. **Sweep.** Every route in `router.ts` that names its permission is tried by every role. A role that has the permission must not be refused; one that lacks it must be. Writes carry a made-up id (the permission check runs before anything is looked up), and a write with no id is only tried by roles that should be refused.
2. **Transactions.** The main roles do their own real work (orders, interactions, cases, fraud alerts, a bill run, ...) and then try work that belongs to another role, which must be refused. Expectations come from the role's own permission list.

The report is `rbac-report-<TAG>.json`.
