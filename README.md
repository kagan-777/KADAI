# kadai backend: API server, database and contract

Node.js + Express + PostgreSQL. Open this folder in VS Code.

## Run in VS Code (5 steps)

1. Install **Node 18+** and **PostgreSQL 14+** (or run only the database with `docker compose up -d`).
2. Create a database and user, for example in `psql`: `CREATE USER kadai WITH PASSWORD 'kadai' SUPERUSER; CREATE DATABASE kadai OWNER kadai;` (SUPERUSER is only needed so the schema can create the `pgcrypto` extension; on a managed database, run `CREATE EXTENSION pgcrypto;` once as admin instead.)
3. Copy `.env.example` to `.env` and check `DATABASE_URL`.
4. In the VS Code terminal: `npm install` then `npm run db:reset` (loads the schema and the section 5 seed data).
5. Press **F5** (Run kadai API) or run `npm start`. Then run `npm test` in a second terminal: it plays the whole benchmark over HTTP and prints PASS/FAIL for 38 checks.

**Open http://localhost:8000/ in your browser: that is the app.** The frontend (`public/`) is served by the same Express server and calls the API at `/api/v1` with real login, so there is nothing to configure between them. `requests.http` has ready-made API requests (install the *REST Client* extension).

Two test suites (run each on a freshly reset database: `npm run db:reset`, restart the server):
- `npm test`: 64 API checks (benchmark workflows, all four snacks, role blocking, and stock rules).
- `python test/ui-test.py`: 40 browser checks that click through the whole benchmark in the real UI across all five roles (needs `pip install playwright` and `playwright install chromium`).
- Set `UI_VIDEO_PATH` to a `.webm` output path when running the UI test to save a dark-mode browser screen recording.
- The Color theme setting includes System default and the four selectable palettes from the supplied color references; the selection is saved in this browser.

## Demo logins (password `kadai123`)

`salesman_a`, `salesman_b`, `admin`, `production`, `auditor`, `owner`. The role you pick at login must match the account.
The demo seed includes five customers: Retailer A, Retailer C and Retailer E belong to `salesman_a`; Distributor B and Distributor D belong to `salesman_b`. Distributor B is the out-of-state GST/IGST example.
Salesmen select Retailer or Distributor first, then choose from their assigned customers.
The four demo products are Murukku, Mixture, Ribbon Pakoda and Kara Sev (all 200 g). The three new recipes are demo assumptions for 200-packet batches; list price is ₹50 and 5% GST with `[DEMO HSN]` placeholders. Confirm recipes, HSN and GST rates before live billing. Run `npm run db:add-snacks` to add them without resetting existing data; database resets also include them.

## What is built, and what is not

Built: all endpoints in `openapi.yaml` except those below. Roles are enforced on the server for every route, and salesmen only see their own customers and orders. Verified here against PostgreSQL 16: `npm test` passed 64 of 64 API checks and the browser test passed 40 of 40 (benchmark numbers, role blocking, stock blocking, GST, credit note, CSV export, invoice PDF, owner monthly comparison, dark theme, color palettes and all snack production/sales).
The owner dashboard also compares the previous calendar month with the current month-to-date for taxable sales, invoice GST, and collections. These figures are derived from existing invoices and payments and shown as a line chart with a comparison table.

Not built yet:
- The `xlsx` and `pdf` formats for reports return `501`. Use `format=csv` (opens in Excel) or `json`. Invoice PDF works.
- The frontend is plain HTML/CSS/JS (no build step). Offline order queue is built (orders typed without network are sent when it returns); invoice edit screens beyond quantity changes are not.
- No partial dispatch, no stock return on credit notes, no rate limiting or password change.
- Change `JWT_SECRET` before any real use.


PostgreSQL schema, seed data, a self-checking benchmark, and an OpenAPI 3 spec for the Order-to-Audit system.
The API server itself is not written yet; the spec is the contract the frontend and server are built against.

## Database notes

```bash
docker compose up -d                                   # loads schema.sql + seed.sql
psql postgresql://kadai:kadai@localhost:5432/kadai -f db/benchmark.sql   # runs section 5, rolls back
```

## Design rules (what makes it correct)

1. **Stock is a ledger, never a number.** `stock_ledger` is append-only (UPDATE/DELETE raise). Balances are `SUM(qty_delta)` in `v_stock_balance`. Every row carries `src_table` + `src_id` back to the purchase, production run, dispatch or adjustment.
2. **No negative stock.** A trigger locks the item row and rejects any movement that would take the balance below zero. The API maps this to `409 INSUFFICIENT_STOCK`.
3. **Money is integer paise** (`bigint`); quantities are `numeric(18,3)` in the item's base unit (kg, l, pc, pkt). Units convert through `units.to_base` and per-item overrides (`item_unit_conversions`, e.g. carton = 20 packets).
4. **Costing = weighted average.** `avg_cost()` = ledger value ÷ ledger quantity at the moment of issue. Chosen because it is simple to audit and gives one stable rate for mixed-price flour (100 kg at ₹42 + 60 kg at ₹45 = ₹43.125/kg). Production output is valued at materials issued; overheads are added as value-only `cost_adjustment` ledger rows. Rule: each run's labour, gas and power go entirely to that run's product.
5. **Variance** (`v_production_variance`): `(actual − planned) / planned` in basis points, flagged when beyond `company_settings.variance_tolerance_bp` (default 300 = 3 %). Yield is compared the same way.
6. **GST** is computed in `create_invoice_from_order()` per line: CGST + SGST when customer state = company state, otherwise IGST. Invoice numbers are `INV/2026-27/0001`, sequenced per financial year (April to March).
7. **Immutability.** Posted invoices cannot be edited or deleted (trigger); `cancel_invoice()` issues a credit note. Posted production runs lock their issues. `audit_row()` logs before/after JSON with the user for key tables. The API must run `SET LOCAL app.user_id = '<id>'` in every transaction.
8. **Offline sync.** `orders.client_uuid` is unique, so a phone can retry a submit safely.

## Benchmark result (checked by `benchmark.sql`)

| Check | Expected | Database |
|---|---|---|
| Flour closing | 120 kg | 120 |
| Oil closing | 19.5 L | 19.5 |
| Pouches closing | 306 | 306 |
| Finished goods after dispatch | 88 | 88 |
| Yield variance | −6 %, flagged | −600 bp, flagged |
| Oil variance | +5 %, flagged | +500 bp, flagged |
| Retailer A invoice | ₹7,875 (CGST ₹187.50 each) | 787500 paise, CGST 18750 |
| Retailer A outstanding | ₹3,875 | 387500 paise |
| Distributor B shortage | 32; IGST | 32; IGST 30000 paise; dispatch blocked |
| Cost per packet | stated | ₹31.14 (weighted average; ₹4,055 materials + ₹1,800 overhead ÷ 188) |

Also flagged by the rules: cartons 10 → 9 (−10 %). Pouches −3 % is exactly at the tolerance, so not flagged ("beyond 3 %").

## Assumptions and gaps

- Opening finished-goods cost of ₹30/packet is an assumption (the brief gives no value). It affects dispatch cost, not the benchmark quantities.
- HSN and GSTIN values are placeholders. Confirm HSN and the 5 % rate before real billing.
- One dispatch per invoice (partial dispatch and stock-returning credit notes are not built).
- Role checks live in the API (`x-roles` in the spec). Add Postgres roles or row-level security as a second layer if you want defence in depth.
- Salesman scoping (own customers and orders only) is an API rule.

## Who can call what

| Endpoint | Salesman | Admin | Production | Auditor | Owner |
|---|---|---|---|---|---|
| `POST /auth/login` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `GET /auth/me` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `GET /customers` | ✔ | ✔ |  |  |  |
| `POST /customers` |  | ✔ |  |  |  |
| `PATCH /customers/{id}` |  | ✔ |  |  |  |
| `GET /customers/{id}/prices` | ✔ | ✔ |  |  |  |
| `GET /customers/{id}/outstanding` |  | ✔ |  | ✔ | ✔ |
| `GET /items` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `POST /items` |  | ✔ | ✔ |  |  |
| `PATCH /items/{id}` |  | ✔ | ✔ |  |  |
| `GET /suppliers` |  | ✔ | ✔ | ✔ |  |
| `POST /suppliers` |  |  | ✔ |  |  |
| `GET /boms` |  | ✔ | ✔ | ✔ | ✔ |
| `POST /boms` |  |  | ✔ |  |  |
| `GET /orders` | ✔ | ✔ |  | ✔ | ✔ |
| `POST /orders` | ✔ |  |  |  |  |
| `GET /orders/{id}` | ✔ | ✔ |  |  |  |
| `PATCH /orders/{id}` |  | ✔ |  |  |  |
| `GET /orders/{id}/stock-check` |  | ✔ |  |  |  |
| `POST /orders/{id}/approve` |  | ✔ |  |  |  |
| `POST /orders/{id}/reject` |  | ✔ |  |  |  |
| `POST /orders/{id}/invoice` |  | ✔ |  |  |  |
| `GET /invoices` |  | ✔ |  | ✔ | ✔ |
| `GET /invoices/{id}` |  | ✔ |  | ✔ | ✔ |
| `GET /invoices/{id}/pdf` |  | ✔ |  | ✔ |  |
| `POST /invoices/{id}/dispatch` |  | ✔ |  |  |  |
| `POST /invoices/{id}/cancel` |  | ✔ |  |  |  |
| `GET /payments` |  | ✔ |  | ✔ | ✔ |
| `POST /payments` |  | ✔ |  |  |  |
| `GET /purchases` |  | ✔ | ✔ | ✔ |  |
| `POST /purchases` |  |  | ✔ |  |  |
| `POST /purchases/{id}/post` |  |  | ✔ |  |  |
| `GET /stock/balances` |  | ✔ | ✔ | ✔ | ✔ |
| `GET /stock/ledger` |  | ✔ | ✔ | ✔ | ✔ |
| `POST /stock/adjustments` |  |  | ✔ |  |  |
| `GET /production-runs` |  | ✔ | ✔ | ✔ | ✔ |
| `POST /production-runs` |  |  | ✔ |  |  |
| `GET /production-runs/{id}` |  | ✔ | ✔ | ✔ | ✔ |
| `PUT /production-runs/{id}/issues` |  |  | ✔ |  |  |
| `POST /production-runs/{id}/post` |  |  | ✔ |  |  |
| `POST /production-runs/{id}/overheads` |  |  | ✔ |  |  |
| `GET /production-runs/{id}/variance` |  | ✔ | ✔ | ✔ | ✔ |
| `GET /production-runs/{id}/costing` |  | ✔ | ✔ | ✔ | ✔ |
| `GET /dashboard` |  | ✔ | ✔ |  | ✔ |
| `GET /reports/{name}` |  | ✔ |  | ✔ | ✔ |
| `GET /audit-log` |  | ✔ |  | ✔ | ✔ |