# Device financing and the credit check

A device bought **on a contract with a plan** ([CATALOG.md](CATALOG.md#devices-on-a-contract-with-a-plan)) is **financed over the contract** by default: the price after the subsidy is split evenly across the whole contract and billed each month together with the plan fee. A **credit check** on the customer's ID number decides whether part of the price is paid upfront first; a weaker credit profile pays more upfront, and the rest is still split evenly.

Everything is set in **Integration → Identity, credit and collections → Credit bureau and device financing** (permission `integration:manage`): the bureau connection first, then the financing settings below it. The old address `/admin/settings?section=device-financing` redirects there. The API is `GET` and `POST /api/integrations/financing`, and `POST /api/integrations/financing/test`.

## How the price is worked out

```
price after subsidy  = retail price − subsidy              (the amount financed)
upfront payment (DUP) = amount financed × upfront share    (from the credit check; 0 when there is no check)
each month            = (amount financed − DUP) ÷ contract months   (rounded down)
```

The share is a percentage of the amount financed. The instalments are billed with the plan, run for exactly the contract length, and are collected on the final bill, by the early-termination rules, if the customer leaves early ([LIFECYCLE.md](LIFECYCLE.md)). A share of 100% means the device is paid in full today.

The customer can always choose **Pay in full instead** (CRM review step; `financing.payInFull` in the API). An explicit payment choice on the device line (`payment: {mode, months, downPaymentMinor}`) is kept as it is.

## Settings

| Setting | Meaning |
|---|---|
| Finance a device over its contract | The default described above. Off: a device on a contract is paid in full at the till unless the line says otherwise. |
| Check the customer's credit profile first | On: a financed device cannot be sold until a valid credit check exists. Off (default): financed with nothing upfront and no check. |
| The bureau returns | `SCORE`: the bands below turn the score into a share. `UPFRONT_AMOUNT`: the bureau names the upfront amount itself. |
| Score bands | Name, score range (0–1000) and upfront share. Bands must not overlap. The starter set is Good 700–1000 = 0%, Fair 600–699 = 10%, Low 500–599 = 25%, Poor 0–499 = 50%. A score no band covers gets the fallback share. |
| If the bureau cannot be reached | Apply the **fallback share** (default 25%), or **stop the sale**. Also applies when no bureau is set up. |
| A check stays valid | 1–365 days (default 30). A check belongs to one customer and one order. |
| Least upfront payment | When a check asks for anything upfront, never less than this amount. |

**Try the credit bureau** on the same page sends an ID number and an amount to the connection, shows the raw score or amount, the band and the resulting upfront payment, and stores nothing against a customer.

## The bureau connection

Under **Integration → Identity, credit and collections → Credit bureau**, add a connection (kind **Credit bureau**). Meridian posts JSON to its address (and the fallback address if the first fails):

```json
{ "idNumber": "S1234567D", "fullName": "…", "dateOfBirth": "1990-01-31",
  "requestedFinancing": { "amountMinor": 120000, "currency": "SGD", "months": 24 }, "reference": "<uuid>" }
```

| Config key | Default | Meaning |
|---|---|---|
| `mode` | `REST` | `SIMULATOR` answers without calling anything: the score follows the last digit of the ID number (0 → 350 … 9 → 890). For trying the flow only. |
| `idField` | `idNumber` | Name of the ID field in the request. |
| `scorePath` | `score` | Where the score is in the answer (dotted path, e.g. `data.creditScore`). |
| `upfrontPath` | none | Where the upfront amount is, when the bureau returns one. |
| `upfrontUnit` | `MINOR` | `MAJOR` if the amount is in whole currency units. |
| `referencePath` | none | The bureau's own reference, kept with the check. |
| `extraBody` | none | Extra fixed fields to send. |
| `auth` / `headerName` | `BEARER` | The key saved with the endpoint is sent as a bearer token, or in the named header (`HEADER`). |

The key is encrypted at rest and never shown again.

## Consent and privacy

- The check cannot run without the customer's **consent**, which is recorded (who recorded it, how, when). The CRM review step has the checkbox; the store-front asks on the confirmation page when a check is needed; the API takes `consent`.
- The ID number is checked against the customer's registered ID first (a typo or another person is refused before anything is sent). It goes to the bureau and nowhere else. Only a **hash** is kept in `credit_checks`, with the score, band, share, decision and the consent.
- Every check is audited.

## Where it applies

| Channel | What happens |
|---|---|
| **CRM order wizard** | The review step shows *Paying for the device*: the split, a *Pay in full* switch, and (when a check is required) the ID number, the consent tick and **Run credit check**. The summary then shows the real upfront payment and the monthly figure. `POST /api/orders/credit-check` runs the check; `creditCheckId` / `payInFull` go on `POST /api/orders` and `/orders/quote` in `financing`. |
| **Store-front** | Quoted as nothing or an estimate upfront and the monthly amount with the plan. At checkout, when a check is required, the verified ID from the identity check is used and the answer sets the amount paid today. The consent tick is required. |
| **Northbound API** | `POST /v1/orders` accepts `creditCheck: {idNumber, consent: true}` (the check runs in the same call), or `creditCheckId` from an earlier check, or `payInFull: true`. See [INTEGRATION_API.md](INTEGRATION_API.md). |

An order is refused with *A credit check is needed before this device can be financed* while one is required and missing, and the order screen's quote shows the same message before anything is placed.

## Data

Migration `0046` adds `credit_checks`. Code: `device-financing.ts` (settings, bureau, check), `financing-check.ts` (the check for a basket), `order-pricing.ts` (the split).
