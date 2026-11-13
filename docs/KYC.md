# Identity verification (KYC)

One workflow for every way a customer is created: the online shop, a store counter, the CRM order screen and the customer record. The same photographs, the same rules, the same review queue, the same consequence for the order.

## The flow

```
 photographs (live camera only) ─▶ automatic rules ─▶ review task ─▶ officer decides ─▶ order
 ID front, back, selfie             age, expiry,        risk and         approve          released and the
 (company: certificate +            duplicate ID,       priority,        reject           service switched on
 signatory's ID)                    reused picture      auto-assigned    send back        — or cancelled and refunded
                                                        to an officer
```

The review itself, in words: **submitted** (every channel ends in the same place) → **risk and priority** are worked out → the case is **assigned automatically** to the compliance officer with the fewest open cases (or waits in the pool) → the officer **decides** (approve, reject, send back) or **escalates** to a senior officer; on a high risk case a **second officer** confirms → the review target (**SLA**) is watched, and an overdue case is **escalated** → afterwards a supervisor can **reopen** it, and a share of approvals get a **quality check** by another officer. Details in [The review workflow](#the-review-workflow).

1. **Photographs are taken, not chosen.** The capture screen opens the device camera itself and grabs a frame; there is no file picker anywhere (a phone's "take photo" file input is not enough: many browsers still offer the gallery). A passport is one page; a card is front and back; an individual also takes a selfie. A company supplies its registration certificate and the signatory's ID.
2. **Where they go.** Into the document vault (encrypted, in the database or the object store configured for documents), against a KYC case. Replacing a photo marks the old one *superseded*; nothing is deleted before the retention rules say so. Every view of a photo is in the document access log. Evidence taken before a shopper becomes a customer is claimed by the customer at checkout, and the clean-up of unclaimed uploads never touches a case that is still being reviewed.
3. **Automatic rules** run before anything is kept. Refused outright: under the minimum age, expired ID, ID number that does not match the customer record, a missing photograph. Flagged for the reviewer: `DUPLICATE_IDENTITY` (the ID belongs to another customer), `IDENTITY_USED_ELSEWHERE`, `IMAGE_REUSED` (the same picture is on another case: how a borrowed or downloaded ID shows up), `NOT_LIVE_CAPTURE` (only when live capture is switched off).
4. **Review.** Submitting opens a task in **KYC reviews** with a case number (`KYC-000123`), its source, ID, flags, risk, how long it has waited (overdue past the review target), who holds it, and how many orders are waiting on it. The reviewer sees the ID number and the photographs (marked *Camera* when taken live; tapping one opens a viewer with zoom by buttons, wheel, pinch or double tap, rotate left or right, drag to pan, and next/previous through the case's pictures) and approves, rejects, or sends back for new photographs, with a reason code. A reject can also add the ID to the **fraud register**, which blocks it everywhere and stops the customer being submitted again. Whoever submitted a case cannot approve it (four eyes); a case sent back can be resubmitted by staff from the customer record or the order wizard.
5. **Consequence.** *Approved*: the customer is **Verified** and every order waiting for activation goes on. *Rejected*: the customer is **Rejected**, the orders waiting on it are cancelled and refunded, and no further service is sold to them. *Sent back*: the customer stays unverified, orders keep waiting, and the staff member retakes the photographs.

## The review workflow

### Who sees what

* **Everyone with `kyc:review`** sees the **whole waiting list** and who holds each case, and can search it. An officer's own screen opens on *My cases* (the API filter `assignee=me`); *Waiting list*, *Unassigned*, *Escalated*, *Overdue*, *My quality checks* and the decided lists are one click away.
* **Only the assignee decides an assigned case.** Someone else is refused with the name of the holder. A person with `kyc:assign` can decide for the holder; it is recorded as decided *on behalf*. A case nobody holds is taken by whoever decides it.
* **`kyc:assign`** (a supervisor) assigns, reassigns and spreads waiting cases, sees every officer's workload and availability, changes anyone's availability, takes a case over, and runs the sweep. **`kyc:senior`** receives escalations and second reviews and may reopen a decided case. **`kyc:report`** sees every officer's KPIs; without it an officer sees only their own. None of the three is held by a built-in role except the new **Compliance Lead** (`ROLE_KYC_COMPLIANCE_LEAD`), which holds all three plus the officer's own permissions; the super user holds everything. They are ordinary assignable permissions (not super-user-only), so they can be added to the KYC Compliance Officer role or a role of your own.

### Risk and priority

Worked out when the case is queued and refreshed by the sweep (`risk_assessed_at`), stored on the case.

| Risk | When |
|---|---|
| HIGH | `DUPLICATE_IDENTITY`, `IMAGE_REUSED`, `PROVIDER_FAIL`, a fraud report on the case or the ID, the ID check service read a different name, date of birth or number than was typed (`PROVIDER_REVIEW` with a mismatch), the ID expired or expires within 30 days, an applicant who has only just reached the minimum age. |
| MEDIUM | Any other flag: `NOT_LIVE_CAPTURE`, `IDENTITY_USED_ELSEWHERE`, `PROVIDER_UNAVAILABLE`, a doubtful `PROVIDER_REVIEW`. |
| LOW | Nothing flagged. |

Priority (higher is first): **overdue 1000**, **escalated 500**, **HIGH 300 / MEDIUM 200 / LOW 100**, **+50 when an order is waiting on the case**. Equal priority: the oldest first. The overdue and waiting-order parts are kept current by the sweep (within a minute); the list sorts by the stored value.

### Automatic assignment

When a case becomes a review task (store-front submit, assisted attestation with a flag, CRM customer check, ID check service referral, resubmission after *sent back*, reopening) it is assessed and, with **automatic assignment** on, given to an officer:

* **Eligible officers** are active users whose roles (with any changes made under Users & roles, and roles you created) include `kyc:review`, who are **not away**, **under the open-case limit**, and **not the person who submitted or attested the case**. The **super user is never given cases automatically** (but can be assigned by hand). A user who is disabled or whose role loses the permission stops being eligible at once.
* **Equal** (default): the officer with the fewest open cases; **ties are broken at random**, so nobody is favoured and the loads stay within one case of each other (300 cases over 3 officers: 100 each). **Round robin**: the next officer in username order after the last one given a case. **Off**: nobody is chosen.
* **Sticky**: a case sent back and submitted again, or reopened, goes back to the officer who had it while they are still eligible.
* If **nobody is eligible** the case waits unassigned in the pool and the **sweep** gives it out later. Officers can also *claim* a case or press *Next case* (the best unassigned case they may review).
* It is safe when two cases are queued at once: the case row is locked and the distribution step takes a database lock for the rest of the transaction, so two submissions never see the same loads. Each decision costs two queries (reviewers and open counts); a batch costs the same.

### Manual assignment (kyc:assign)

*Assign* to one officer, *Spread equally* over several (their current load counts), or *Unassign* (back to the pool), for chosen cases or for everything a filter matches, up to **2,000 cases per call**, in one set-based update. Targets are picked from a searchable list of active holders of `kyc:review` (type-ahead; `*` and `?` work). A case that cannot move is **skipped with its reason** (already decided, not waiting yet, assigned to that officer already, the officer submitted it) and the rest go through. Moving a case someone holds needs a **reason**. An away officer can be chosen only after a confirmation (`force`). Each new assignee gets **one notification per batch**; a failing notification never fails the batch. With automatic assignment on, cases put back in the pool are given out again at the next sweep.

### The sweep

`POST /kyc/sweep` (also run by the server's heartbeat about once a minute; idempotent; safe on several servers at once) does four things, in this order:

1. **Refresh** risk and priority: overdue cases jump the queue, cases from before this feature get their first assessment, orders placed since the case was queued count.
2. **Take back** cases from officers who are away (if *redistribute away*), disabled, or no longer hold `kyc:review`, and give them to others (the officer is told).
3. **Assign** unassigned waiting cases, most urgent first, up to 500 per run.
4. **Mark and escalate**: a case past the review target gets an `SLA_BREACHED` event and its holder an alert; an assigned case still open `escalateOverdueHours` after the target is **escalated** to a senior officer (a holder of `kyc:review` and `kyc:senior`; failing that `kyc:assign`; failing that it stays and is only flagged).

### What the officer does

* **Decide**: approve, reject, send back, with the **checklist** (document legible, photo matches the ID, details match the ID, not expired, age OK, not a duplicate; *not applicable* where there is nothing to compare). The checklist is stored with the case and the decision event. With *Require the checklist* on, approving needs every applicable tick or a note that explains.
* **Notes** on the case timeline. **Claim** and **release** (release needs a reason; the case goes back to the pool and is not handed straight back to the person who released it).
* **Escalate** to a senior officer or a named reviewer, with a note. The case stays waiting, now flagged and higher in the list.
* **Second review** (setting *Four eyes on HIGH risk*): the first officer's approve or reject on a HIGH risk case is only a **recommendation** (`RECOMMENDED`, kept in `second_review`). The case goes to a **different** eligible officer (failing that a senior one, failing that the pool where anyone but the first officer may take it). Only the second officer's decision is applied, as **confirm** or **override** (an override needs a note), and it is the second officer who is recorded as the decider. Sending a case back is never held for a second look.
* **Availability**: *I am away* (optionally until a time; ends by itself). An officer who is away gets no new cases and, by setting, hands the open ones back.
* **Quality check**: with a sampling share above 0, that share of **approvals made by a person** is given to a different officer, who marks *agree* or *disagree* (a disagreement needs a note); the decider is told. The tasks are in *My quality checks* (`qa=1`) and count in the KPIs.
* **Reopen** (`kyc:senior` or `kyc:assign`), within *reopen days* of the decision: the case goes back to waiting (new risk and priority, the officer who decided it gets it again when eligible), the customer is *In review* again.
  * **Rejected** and **sent back** cases reopen freely. A rejection that was **reported as suspected fraud** does not reopen (the fraud register entry has to be looked at first). The orders cancelled and refunded by a rejection are **not** brought back; the customer orders again after approval.
  * **Approved** cases reopen **only while no service has been activated since the approval**. The customer returns to *In review*, so a service that is not yet activated waits for the new decision. An activated service is never switched off by reopening, so once one exists the approval stands. (To re-verify a customer who already has services, submit a new identity check from the customer record.)

Everything above is an entry on the case's **timeline** (`CREATED`, `SUBMITTED`, `ASSIGNED`, `REASSIGNED`, `UNASSIGNED`, `CLAIMED`, `RELEASED`, `OPENED` (the assignee's first open), `NOTE`, `ESCALATED`, `RECOMMENDED`, `SECOND_REVIEW_DECIDED`, `DECIDED`, `RETURNED`, `REOPENED`, `SLA_BREACHED`, `QA_SAMPLED`, `QA_DONE`) and, for assignments and decisions, a row in the **audit log** with the actor.

### Searching

One search box, one syntax: `*` is any run of characters, `?` exactly one, everything else is literal and ignores case; `%`, `_` and `\` are just characters. **No wildcard means "contains"; with a wildcard the pattern must match the whole value** (`tan*` starts with tan, `*tan` ends with it). It looks in the full name, the masked ID number (its last digits), the case number (`KYC-123`, `kyc123` or `123`), the customer's name, phone and e-mail, the officer holding the case (username or name), and, on the waiting list, the number of an order waiting on the case. A **whole ID number typed exactly** is found by comparing its keyed hash; the decrypted number is never searched. The pattern is applied inside the filtered set (status, assignee, source, risk, dates), so *waiting* is fast; with status *any* it is a scan with `ILIKE` over the cases (tens of thousands answer well under a second; narrow by status, assignee or date on a very large history). Indexes: priority order of waiting cases, the officer's cases, the pool, decided cases by time and by officer, and the case number.

### Officer KPIs

From the case timeline, so a case that was reopened and decided again counts for each decision. Buckets are days, weeks (Monday first) or months in the **regional time zone** (Settings → Regional; the report says which in `tz`); empty buckets are present with zeros. Only decisions by people count (automatic approvals and rejections are not an officer's work).

| Number | How it is computed |
|---|---|
| **decided** (reviews done) | approvals + rejections + sent back, counted for whoever made the decision (on behalf counts for the person who pressed the button) in the bucket of the decision time |
| approved / rejected / returned | the three parts of *decided* |
| **avg / median minutes** | from the case being assigned to that officer (else first opened, else submitted) to the decision; decisions imported from before this feature have no time and are left out |
| **slaMetPct** | decisions made no later than the review target after submission, as a share of decisions that carry the information |
| overdueAtDecision | decisions made after the target |
| escalated | cases that went up from the officer: escalated by them, or taken from them automatically because they were overdue |
| reopened | decisions of the officer that a supervisor later reopened (counted when it is reopened) |
| assigned | new cases that came to the officer: assigned, reassigned, claimed, or escalated to them |
| qaAgreePct | of the officer's approvals that another officer checked, the share they agreed with |
| open, oldestOpenHours | cases the officer holds right now, and the age since submission of the oldest (not limited to the period) |

The **team** series and totals count every officer's decisions together (median over all decisions). *My numbers* shows an officer today, this week and this month. Decisions made before the review workflow existed were added to the timeline by migration `0060` (without minutes), so the history is not empty.

## Settings (Settings → KYC review, `settings:manage`)

| Setting | Default | Meaning |
|---|---|---|
| `autoAssign` | on | Give each new case to an officer at once. |
| `strategy` | `EQUAL` | `EQUAL` (fewest open, ties random), `ROUND_ROBIN`, or `OFF`. |
| `maxOpenPerOfficer` | 0 | Open cases one officer may be given automatically or claim; 0 is no limit. Supervisors may exceed it by hand. |
| `stickyOnResubmit` | on | A case sent back and resubmitted (or reopened) returns to the same officer while eligible. |
| `redistributeAway` | on | Open cases of an officer who goes away go back into the distribution (disabled officers always do). |
| `escalateOverdueHours` | 12 | An assigned case still open this many hours after the review target is escalated; 0 is never. |
| `fourEyesHighRisk` | off | First decision on a HIGH risk case is a recommendation; a different officer confirms. |
| `qaSamplePercent` | 0 | Share of approvals (0 to 100) that another officer checks again. |
| `reopenDays` | 14 | How long after a decision a supervisor may reopen. |
| `requireChecklist` | off | Approving needs every applicable check ticked, or a note. |

The review target itself (`kycSlaHours`) stays under Integration → Store-front.

## With an ID check service

Camera photographs stay the default way to start. Under **Integration → Identity verification (ID check service)** an administrator connects a REST service that reads the photographs. After the local rules, the photographs and the typed details are sent to it and the answer decides what happens next:

```
 camera photos ─▶ local rules ─▶ ID check service ─▶ pass and clean ─▶ Verified, waiting order released
                                 (OCR, face, liveness) ├─ doubtful ──────▶ review task, the service's verdict shown to the reviewer
                                                       ├─ fail ──────────▶ Rejected, order cancelled and refunded
                                                       └─ unreachable ───▶ review task (nobody is rejected because a service is down)
```

* **What is sent:** `POST {address}` with JSON `{ reference, idType, claimed: { fullName, dateOfBirth, idNumber, idExpiry, nationality }, images: { ID_FRONT, ID_BACK, SELFIE } }` (base64 JPEG). Authentication is a bearer token, a named header, or none; the key is encrypted and never shown again.
* **What is read:** any JSON. The *response map* names where each value lives (dot paths such as `extracted.fullName`); the defaults suit a typical service. Every value is optional, so **a service that only checks the document works**: face match and liveness are judged only when the service returns them.
* **How the answer is judged:** the service's own verdict (words that mean pass or fail are configurable; any other word means "not sure"); name, date of birth and ID number it read are compared with what was typed; a face-match score below the *pass* limit sends the case to a person and below the *fail* limit fails it; a liveness result that is not a pass sends it to a person. Nothing the service says can approve a case that the local rules flagged.
* **Switches:** *approve a clean pass without a person* (on by default) and *reject a fail without a person* (on by default). With either off the case goes to the review queue instead. These apply whatever the store-front's manual/automatic mode says.
* **Unreachable or unreadable:** a timeout, a connection error, a non-2xx answer, or a body that is not JSON puts the case in manual review with the flag `PROVIDER_UNAVAILABLE`. That flag does not stop a shopper going on to pay while the review is pending.
* **The reviewer** sees the verdict (passed / not sure / failed / not available), the reasons, and for each check whether it matched, with the face score. The verdict helps; the reviewer still compares the photographs.
* **Trying it:** choose *Simulator*. The ID number's ending picks the answer: `…9999` fails, `…0000` goes to review, `…5555` simulates an outage, anything else passes.

## MyDigital ID as an alternative

Under **Integration → MyDigital ID** an administrator sets up the connection (issuer, client id and secret, the redirect addresses registered with MyDigital ID, and the claim names). Then the customer chooses how to prove identity: **photograph the ID**, or **use MyDigital ID**.

* The flow is OpenID Connect with a code and PKCE. The customer approves in their MyDigital ID app and comes back. Meridian verifies the signed answer (signature, issuer, audience, nonce, expiry), compares the **ID number** (required), **name** and **date of birth** with what was typed, then runs the same age, expiry and duplicate rules.
* **No photographs** exist for such a case. A confirmed identity is verified at once (switchable: *confirmed identities are verified without a person*; with it off, or if a rule flags it, a review task opens and the reviewer sees what MyDigital ID confirmed).
* **If it does not match, or the customer says no, or the provider is down:** nothing is created or approved. The screen says what to do (correct the details or photograph the ID instead) and the photograph route is still open. The attempt can only be used once and expires after 15 minutes.
* **Store-front:** the choice sits on the ID step. MyDigital ID returns to the shop's `/apply/mydigitalid` page, which hands the code to the shop's API. The confirmation is attached to the sign-up; the shopper still goes through the address, agreements and consent, and the case is decided when they submit. Changing the name, ID number or date of birth afterwards cancels the confirmation.
* **CRM:** the customer form and the *Identity check* card offer the same choice. The customer record is **not created** until MyDigital ID confirms; the typed form waits, encrypted, in the attempt and is erased afterwards. MyDigital ID opens in a pop-up and the screen waits for the answer. Register the CRM redirect address `https://<crm>/api/kyc/mydigitalid/callback`.
* Leave a redirect address blank to switch MyDigital ID off for that channel. Companies always use the photographs.

## Customer status

| Status | Meaning |
|---|---|
| Not verified | Nothing submitted (an older or migrated record). |
| In review | Photographs submitted; a review task is open. |
| Verified | Approved by a person or by the automatic rules. |
| Rejected | Not approved; services cannot be sold (a fresh attempt is possible unless it was reported as fraud). |

## In the CRM

* **New customer** (order wizard or Customers): the form has an **Identity check** section. The customer is created only together with their photographs and review task, in one transaction: a refusal (under age, missing photo, gallery photo) leaves nothing behind. ID type, expiry (required for a passport or permit), date of birth and nationality are asked there; the customer's name and ID number come from the form.
* **Existing customers** with no verified identity show an **Identity check** card on their record and in the order wizard's customer step, with the camera form to start or redo the check. The wizard will not continue to a service sale until a check has been submitted.
* **Order screen**: while activation waits, a banner says so and links to the check; the order's tasks list *KYC*.

## In the store-front

The ID step is the same camera capture. When the check is clean and only waiting for a person, the shopper is **not** made to wait: they go on to pay, and the confirmation says the service switches on when the check is approved (refund in full otherwise). A case with a flag (a duplicate ID, a reused picture) must be decided before checkout, as before.

## Settings (Integration → Store-front → Identity verification)

| Setting | Meaning |
|---|---|
| Online sign-ups approved by | A compliance officer (default), or automatic rules only. Also applies to CRM cases. A connected ID check service or MyDigital ID approves a clean pass by its own switch. |
| Only live camera photos | On by default. The server also refuses files that look like gallery photos (they carry EXIF/XMP metadata), pictures older than 15 minutes, non-JPEG files and pictures under 640×400. Switch off only for a partner sending scans through the API. |
| Minimum age | Under it is refused, online and in the CRM. |
| When identity must be settled | **Before the service is switched on** (default): the order is taken and paid, the service is activated on approval. **Before the order**: nothing is sold until approved (the former "require KYC for services"). |
| Review target | Hours before a waiting task shows as overdue. |

## What the camera check can and cannot do

It stops the honest mistake (a wrong picture from the album) and the casual shortcut (uploading any file): a frame grabbed from the camera has no photo-library metadata and is timed by the server. It cannot stop someone who points the camera at a screen or uses a virtual camera, or who calls the API directly with a crafted file. For that, connect an ID check service with document authenticity and liveness checks (above); its verdict feeds the same cases, queue and decisions. The reviewer's *Reported to fraud register* path and the `IMAGE_REUSED` flag cover the repeat offenders.

## API

| Call | Purpose |
|---|---|
| `POST /customers` | `identity: { idType, idExpiry?, nationality?, dateOfBirth?, documents: [{ kind, dataBase64, capture }] }` is required with the customer fields. `capture` is `{ method: 'LIVE_CAMERA', at, facing?, width?, height? }`. |
| `GET /customers/:id/kyc` | Status, the case, which photographs are on file (never the images), orders waiting. |
| `POST /customers/:id/kyc` | Start or redo the check: the identity fields, `idNumber` (must match the record) and `documents`. |
| `GET /kyc/cases` | `kyc:review`. `status`, `assignee` (`me`, `unassigned`, `any` (default), a username), `q` (wildcards), `source`, `risk`, `flag`, `overdue=1`, `escalated=1`, `qa=1` (my quality checks), `from`, `to` (`YYYY-MM-DD`, submission date in the regional time zone), `sort` (`priority` (default for waiting cases), `oldest`, `due`, `newest` (default otherwise)), `limit`, `cursor`. Returns `{ items: [{ id, caseNumber, fullName, idType, idNumberMasked, source, method, status, flags, risk, priority, submittedAt, dueAt, overdue, waitingOrders, assignedTo, assignedToName, assignedAt, assignmentSource, escalated, decidedBy, decidedAt, reasonCode, applicationId, customerId, qaAssignedTo, qaResult, secondReviewStatus }], nextCursor }`. |
| `GET /kyc/summary` | `{ waiting, overdue, unassigned, mine, mineOverdue, escalated, awaitingSecondReview, decidedToday, qaTasks }` (the last four are the caller's). |
| `GET /kyc/cases/:id` | The case with its documents, plus `caseNumber, risk, priority, dueAt, assignedTo, assignedToName, assignedAt, assignmentSource, events[{ at, actor, actorName, action, detail }], notes, checklist, secondReview, canDecide, canClaim, canRelease, canAssign, canEscalate, canReopen, decideBlockedReason, reopenBlockedReason`. Opening it is audited; the assignee's first open is recorded. |
| `POST /kyc/cases/:id/decision` | `{ decision, reason?, reasonCode?, reportFraud?, checklist? }`. Reporting to the fraud register needs `fraud:manage`. On a high risk case with four eyes on, the answer is `{ status: 'PENDING', awaitingSecondReview: true, secondReviewer }`. |
| `POST /kyc/cases/:id/claim`, `/release` `{ reason }`, `/escalate` `{ note, to? }`, `/notes` `{ text }`, `/second-review` `{ decision: 'CONFIRM' or 'OVERRIDE', decisionBody?, note? }`, `/qa` `{ result: 'AGREE' or 'DISAGREE', note? }` | `kyc:review`. |
| `POST /kyc/cases/:id/reopen` `{ reason }` | `kyc:senior` or `kyc:assign`. |
| `POST /kyc/cases/:id/take-over` `{ reason }` | `kyc:assign`: take a case someone else holds. |
| `POST /kyc/next` | `kyc:review`: takes the best unassigned case for the caller. `{ caseId }` or `{ caseId: null }`. |
| `GET /kyc/officers?q=&limit=` | `kyc:assign`: the type-ahead source. `{ items: [{ username, displayName, roles, open, overdue, away, awayUntil, capacityLeft, eligible, notEligibleReason, isSuperuser }] }`. |
| `GET /kyc/workload` | `kyc:assign`: `{ officers: [{ username, displayName, away, open, overdue, oldestHours, decidedToday, decidedWeek }], unassigned, unassignedOverdue, oldestUnassignedHours }`. |
| `POST /kyc/assignments` | `kyc:assign`: `{ caseIds? (max 2000), filter? (the list filters; max 2000 cases), mode: 'ASSIGN' / 'DISTRIBUTE' / 'UNASSIGN', officer?, officers?, reason?, force? }` returns `{ requested, assigned, skipped: [{ caseId, caseNumber, reason }], perOfficer }`. |
| `GET /kyc/me`, `POST /kyc/me/status` | The caller's numbers (`today`, `week`, `month`, `open`, `overdue`, `avgMinutesWeek`) and availability `{ away, awayUntil?, note? }`. `POST /kyc/officers/:username/status` (`kyc:assign`) is the same for anyone. |
| `GET /kyc/reports/officers`, `/kyc/reports/officers.csv` | `from`, `to`, `by` (`day`, `week`, `month`), `officer`, `source`. With `kyc:report` every officer; without it only the caller's own row (asking for another officer is refused). `{ period: { from, to, by, tz }, officers: [{ username, displayName, totals, series }], team: { totals, series }, buckets }`. |
| `POST /kyc/sweep` | `kyc:assign` or `settings:manage`: `{ assigned, redistributed, escalated, breached, refreshed }`. For a scheduler; the server also runs it about once a minute. |
| `GET` and `POST /settings/kyc-review` | `settings:manage`. The settings above; a change may send only the fields it changes; nonsense (a negative limit, a share over 100) is refused. |
| `POST /store/applications/:id/documents` | Store-front photo: `{ kind, dataBase64, capture }`. |
| `GET /kyc/methods` | Which ways are open: photographs, the ID check service, MyDigital ID per channel. The store-front gets the same in `/store/config` (`kyc.methods`). |
| `POST /kyc/mydigitalid/customer` | New customer by MyDigital ID: the customer fields plus `identity: { idType, idExpiry?, nationality?, dateOfBirth? }` (no photographs). Returns `{ sessionId, url }`. |
| `POST /customers/:id/kyc/mydigitalid` | Existing customer: `{ idType, idNumber, … }`. Returns `{ sessionId, url }`. |
| `GET /kyc/mydigitalid/sessions/:id` | Poll the attempt (only whoever started it): `PENDING`, `DONE` (with `customerId`, `caseStatus`) or `FAILED` (with a message). |
| `GET /kyc/mydigitalid/callback` | The CRM redirect address. Public; finishes the attempt and shows a page to close. |
| `POST /store/applications/:id/mydigitalid`, `POST /store/mydigitalid/complete` | Store-front start and return. |
| `POST /kyc/mydigitalid/test` | Administrators: can the provider's settings be read? |

Events for subscribers: `KYC_SUBMITTED` and `KYC_DECIDED` (TMF 688 `PartyIdentification…` notifications).

## Data

Migration `0056`: customer status values; `kyc_cases` can belong to a customer alone (`application_id` optional) with `source` (`STOREFRONT`, `ASSISTED`, `CRM_ORDER`, `CRM_CUSTOMER`), `submitted_at/by`, `order_id`, `reason_code`, `fraud_reported`; `documents.kyc_case_id`. Older store-front photographs stay in the legacy table and are read through the vault as before.

Migration `0057`: the Integration hub group `identity` (kinds `KYC_OCR`, `KYC_MYDIGITALID`), case method `MYDIGITAL_ID`, and `kyc_provider_sessions` (one redirect to the provider and back; state is stored hashed, the typed form encrypted and cleared when done). The new flags are `PROVIDER_REVIEW`, `PROVIDER_FAIL` and `PROVIDER_UNAVAILABLE`; the verdict is kept on the case as `checks.provider`, MyDigital ID's confirmation as `checks.mydigitalid` (a short reference, never the ID number or tokens).

Migration `0060` (additive, safe on ~100k cases): on `kyc_cases` the case number (`KYC-000123`, from a sequence, existing cases numbered in order of creation), `assigned_to/at/by`, `assignment_source` (`AUTO`, `MANUAL`, `CLAIMED`, `ESCALATED`), `previous_assignee`, `avoid_assignee`, `risk`, `priority`, `risk_assessed_at`, `escalated_at/by`, `escalation_note`, `sla_breached_at`, `first_opened_at`, `reopened_count`, `checklist`, `second_review`, and the quality check (`qa_assigned_to`, `qa_sampled_at`, `qa_result`, `qa_note`, `qa_by`, `qa_at`); the timeline table `kyc_case_events`; `kyc_officer_status` (who is away); the indexes behind the lists. Cases that are waiting when it is applied are **not** assigned by the migration: the first sweep assigns them. Settings are one row in `settings` (`kycReview`).
