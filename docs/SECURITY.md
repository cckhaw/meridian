# Security model

## Authentication
- **Login** with username and password. Passwords are hashed with scrypt (N=32768, per-user salt). Minimum 12 characters, a common-password blocklist, and no username in the password.
- **Super user** credentials live only in environment variables. The super user has no password in the database, cannot be edited through the API, and changing either variable invalidates its sessions.
- **Sessions** are opaque random tokens in an `HttpOnly`, `SameSite=Lax` cookie (`__Host-` prefixed and `Secure` in production). Only a SHA-256 of the token is stored. Idle timeout 30 minutes, absolute 12 hours. They are revoked on sign-out, password change or reset, role/scope change, and disabling.
- **Brute force**: lockout after 5 failures per account, plus throttling per client address and per username (including non-existent ones). Failed and successful sign-ins are audited. Unknown and wrong-password cases return the same message and take the same time.
- New and reset users get a one-time password and must change it at first sign-in.

## Authorisation
- Every API route declares the permission it needs; the dispatcher enforces it before the handler runs, and denied attempts are audited. See [ROLES.md](ROLES.md) (generated from code and checked by a test).
- **Row scope**: customer-portal users reach only their own customer; store users only their store’s orders and stock; dealers only their dealer’s orders and commission. A miss returns `404` so identifiers cannot be probed. Client-supplied filters cannot widen scope.
- **Identity of the seller** (store, dealer, salesperson) comes from the session, never the request body.
- **Changing roles is itself a privileged act.** Editing what a role may do, creating or deleting a role needs `user:manage`, is audited with the permissions added and removed, and has guardrails: `settings:manage` can never be given to any role, the Administrator role always keeps `user:manage`, a role that no longer exists grants nothing (and never widens a user's scope), and a created role that sees only a store or dealer fails closed without that binding.
- **Customers acting on their own service** (`service:self`) can suspend and resume their own lines only; a fraud, administrative or credit restriction can be lifted by staff only, and a dunning bar lifts by payment. Waiving or reducing an early-termination charge needs `order:override`. Stock can only be reduced by a write-off with a reason (`inventory:writeoff`), and warehouse changes need `warehouse:manage`; both leave history.
- The UI hides what a role cannot use, but that is presentation only: the API is the control.

- **Administrators are privileged.** They can create staff and issue one-time passwords, so an administrator could in principle sign in as someone they created or reset. To limit this: nobody can edit their own account through user administration, only the super user can grant or remove the Administrator role, administrators cannot move money themselves, and every user change is audited. Treat administrator accounts like production root, require MFA when you add it, and review the audit log.

## Store-front API
- Machine access is by **API key** (`Authorization: Bearer mk_…`): only a SHA-256 of the secret is stored, comparison is constant-time, every failure is the same `401`, keys can be revoked instantly and show last use. A key can reach only the store endpoints, never staff routes; a staff session cannot call them either.
- A shopper’s application needs the creating key **and** its secret token; unknown, foreign and wrong-token requests are indistinguishable (`404`). Sign-ups are throttled per address.
- The store-front keeps the key and token server-side (HttpOnly cookie for the token), so page scripts cannot read them; its mutations are same-origin only.
- Payment webhooks are authenticated by the provider’s signature, bound to amount and currency, de-duplicated by event id and replay-limited.
- A KYC duplicate cannot be approved online, and the existing customer’s id is never disclosed.

## Numbering

Pool management needs `numbering:manage`; sellers hold only `numbering:select`. Tier regexes are validated before saving (no nested quantifiers, bounded length) so a rule cannot stall the server. Every identifier change is audited in `identifier_lifecycle_audit`. IMSIs are SIM secrets-adjacent: they are shown only to `numbering:read`.

## Request hardening
- State-changing requests must carry a matching `Origin` (CSRF). The payment webhook is exempt and uses an HMAC signature instead.
- Request bodies are capped at 1 MB and validated with schemas. Errors never include stack traces or SQL.
- Headers: CSP (self-only; `unsafe-inline` for the framework’s inline scripts and styles), `X-Frame-Options: DENY`, HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy`.
- Order placement accepts an `Idempotency-Key` so retries cannot double-order.
- Fail closed: a production deployment with missing or weak secrets serves nothing.

## Data protection
- ID documents entered in the CRM’s customer form are never stored; only a masked form and a keyed hash for duplicate detection.
- **KYC evidence** (ID number, ID/selfie/signature images) collected for sign-ups is stored **encrypted** (AES-256-GCM; key from `MERIDIAN_DATA_KEY`/`MERIDIAN_ID_PEPPER`), checked for integrity on read, shown only to `kyc:review`, and every view is audited. File types are identified by signature; SVG is never accepted.
- Money is integer minor units. Every financial event posts a balanced journal; reconciliation checks it.
- Encryption at rest and in transit is the database and hosting platform’s job (TLS to the database is required in production).

## Not covered yet (plan for these before regulated go-live)
- **Multi-factor authentication and single sign-on** (SAML/OIDC). Strongly recommended for staff before handling real customer data.
- **Self-service password reset and portal sign-up** (needs email/SMS delivery and identity verification).
- **Per-request CSP nonces** (removing `unsafe-inline`), WAF and DDoS protection, and distributed rate limiting at the edge.
- **Column-level encryption** for contact details, retention and erasure workflows, and consent records (GDPR/PDPA).
- An independent **penetration test** and a review against your regulator’s requirements (for example MAS TRM, PDPA, local telecom licensing rules).
- Approval workflows (maker-checker) beyond the per-role credit limit.
