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
| Online sign-ups approved by | A compliance officer (default), or automatic rules only (use with an eKYC provider behind the same checks). Also applies to CRM cases. |
| Only live camera photos | On by default. The server also refuses files that look like gallery photos (they carry EXIF/XMP metadata), pictures older than 15 minutes, non-JPEG files and pictures under 640×400. Switch off only for a partner sending scans through the API. |
| Minimum age | Under it is refused, online and in the CRM. |
| When identity must be settled | **Before the service is switched on** (default): the order is taken and paid, the service is activated on approval. **Before the order**: nothing is sold until approved (the former "require KYC for services"). |
| Review target | Hours before a waiting task shows as overdue. |

## What the camera check can and cannot do

It stops the honest mistake (a wrong picture from the album) and the casual shortcut (uploading any file): a frame grabbed from the camera has no photo-library metadata and is timed by the server. It cannot stop someone who points the camera at a screen or uses a virtual camera, or who calls the API directly with a crafted file. For that, switch the review to an eKYC vendor with document authenticity and liveness checks; the cases, queue and decisions here are the place it plugs in. The reviewer's *Reported to fraud register* path and the `IMAGE_REUSED` flag cover the repeat offenders.

## API

| Call | Purpose |
|---|---|
| `POST /customers` | `identity: { idType, idExpiry?, nationality?, dateOfBirth?, documents: [{ kind, dataBase64, capture }] }` is required with the customer fields. `capture` is `{ method: 'LIVE_CAMERA', at, facing?, width?, height? }`. |
| `GET /customers/:id/kyc` | Status, the case, which photographs are on file (never the images), orders waiting. |
| `POST /customers/:id/kyc` | Start or redo the check: the identity fields, `idNumber` (must match the record) and `documents`. |
| `GET /kyc/cases`, `/kyc/cases/:id`, `/kyc/summary` | Queue (filters: Needs review, Sent back, Approved, Rejected), one case, counts waiting and overdue. |
| `POST /kyc/cases/:id/decision` | `{ decision, reason?, reasonCode?, reportFraud? }`. Reporting to the fraud register needs `fraud:manage`. |
| `POST /store/applications/:id/documents` | Store-front photo: `{ kind, dataBase64, capture }`. |

Events for subscribers: `KYC_SUBMITTED` and `KYC_DECIDED` (TMF 688 `PartyIdentification…` notifications).

## Data

Migration `0056`: customer status values; `kyc_cases` can belong to a customer alone (`application_id` optional) with `source` (`STOREFRONT`, `ASSISTED`, `CRM_ORDER`, `CRM_CUSTOMER`), `submitted_at/by`, `order_id`, `reason_code`, `fraud_reported`; `documents.kyc_case_id`. Older store-front photographs stay in the legacy table and are read through the vault as before.
