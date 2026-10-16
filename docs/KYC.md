# Identity verification (KYC)

One workflow for every way a customer is created: the online shop, a store counter, the CRM order screen and the customer record. The same photographs, the same rules, the same review queue, the same consequence for the order.

## The flow

```
 photographs (live camera only) ─▶ automatic rules ─▶ review task ─▶ decision ─▶ order
 ID front, back, selfie             age, expiry,        KYC reviews    approve     released and the
 (company: certificate +            duplicate ID,       (oldest         reject      service switched on
 signatory's ID)                    reused picture      first, SLA)     send back   — or cancelled and refunded
```

1. **Photographs are taken, not chosen.** The capture screen opens the device camera itself and grabs a frame; there is no file picker anywhere (a phone's "take photo" file input is not enough: many browsers still offer the gallery). A passport is one page; a card is front and back; an individual also takes a selfie. A company supplies its registration certificate and the signatory's ID.
2. **Where they go.** Into the document vault (encrypted, in the database or the object store configured for documents), against a KYC case. Replacing a photo marks the old one *superseded*; nothing is deleted before the retention rules say so. Every view of a photo is in the document access log. Evidence taken before a shopper becomes a customer is claimed by the customer at checkout, and the clean-up of unclaimed uploads never touches a case that is still being reviewed.
3. **Automatic rules** run before anything is kept. Refused outright: under the minimum age, expired ID, ID number that does not match the customer record, a missing photograph. Flagged for the reviewer: `DUPLICATE_IDENTITY` (the ID belongs to another customer), `IDENTITY_USED_ELSEWHERE`, `IMAGE_REUSED` (the same picture is on another case: how a borrowed or downloaded ID shows up), `NOT_LIVE_CAPTURE` (only when live capture is switched off).
4. **Review.** Submitting opens a task in **KYC reviews**: source, ID, flags, how long it has waited (overdue past the review target), and how many orders are waiting on it. The reviewer sees the ID number and the photographs (marked *Camera* when taken live) and approves, rejects, or sends back for new photographs, with a reason code. A reject can also add the ID to the **fraud register**, which blocks it everywhere and stops the customer being submitted again. Whoever submitted a case cannot approve it (four eyes); a case sent back can be resubmitted by staff from the customer record or the order wizard.
5. **Consequence.** *Approved*: the customer is **Verified** and every order waiting for activation goes on. *Rejected*: the customer is **Rejected**, the orders waiting on it are cancelled and refunded, and no further service is sold to them. *Sent back*: the customer stays unverified, orders keep waiting, and the staff member retakes the photographs.

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
| `GET /kyc/cases`, `/kyc/cases/:id`, `/kyc/summary` | Queue (filters: Needs review, Sent back, Approved, Rejected), one case, counts waiting and overdue. |
| `POST /kyc/cases/:id/decision` | `{ decision, reason?, reasonCode?, reportFraud? }`. Reporting to the fraud register needs `fraud:manage`. |
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
