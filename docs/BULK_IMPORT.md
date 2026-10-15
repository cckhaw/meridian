# Bulk import and export

Dealers, dealer agents and stores can be downloaded, edited in a spreadsheet and loaded back, from the **Import / export** button on the **Dealers** and **Stores** pages. (Catalog offers and stock have their own, with the same steps: see [CATALOG.md](CATALOG.md) and the Inventory page.)

| Page | Files | Needs |
|---|---|---|
| Dealers | **Dealers** (with tier, parent and bank details) and **Agents** | `dealer:manage` (Dealer Desk, Administrator). Tier, parent, bank and SAP columns, and the bank details in a download, also need `commission:configure` |
| Stores | **Stores** | `store:manage` |

A dealer's own login (the Dealer role) and store logins cannot use these.

## The steps

1. **Download a file.** *Empty template* has the header and comment lines that explain each column, with an example (a comment, so it is never loaded). *Download my current dealers/agents/stores* holds everything there is now, in the same layout, so it can be edited and loaded straight back. Up to 5,000 rows a file.
2. **Choose the filled-in file** and **Check** it. A check changes nothing and does not use up any ids.
3. **Load** it. Every row must be fine, and then all rows load together; otherwise nothing is loaded and each problem is listed by line.

## How rows are read

* The **id** is the key (`dealer_id`, `agent_id`, `store_id`). A row whose id exists **updates** it; a row with **no id adds** a new one, and the system issues the id (DLR-00001, DLR-00001-A001, STORE-00001). An id that does not exist is refused: ids are never chosen by hand.
* On an update, a **blank cell leaves the field as it is**, and a single **`-`** clears it. A new row's blank cells are simply empty (status defaults to ACTIVE).
* Lines that start with `#` and empty rows are ignored. Column names are not case sensitive, and a column the import does not know is refused (it is probably a typo).
* The same rules as the screens apply: a store name is unique, an email must look like one, an agent needs an active dealer, a dealer's parent must exist, cannot be itself or one of its own sub-dealers, and the channel is at most six levels deep.

| File | Columns |
|---|---|
| Dealers | `dealer_id, name, contact_name, email, phone, status, tier, parent_dealer_id, bank_account_name, bank_account_no, bank_code, sap_vendor_no` |
| Agents | `agent_id, dealer_id, name, email, phone, status` (an agent stays with its dealer: to move one, switch it off and add a new one) |
| Stores | `store_id, name, address, phone, status, market_code` (market only when several markets are on) |

Because a new dealer's id is issued by the system, a new dealer cannot be named as a parent in the same file: **load parents first**, then their sub-dealers (the download then gives you their ids).

## Good to know

* Excel drops the leading `+` and zeros of phone and account numbers unless the column is formatted as **Text** before the file is opened or pasted into. The template says so.
* The download of dealers includes bank account numbers for people who may configure commission, and every download is recorded in the audit log, as is every load.
* Nothing is ever deleted by a file. To retire a dealer, agent or store, set `status` to `INACTIVE`.
* The file is read as UTF-8 text, comma separated, up to 2 MB.
