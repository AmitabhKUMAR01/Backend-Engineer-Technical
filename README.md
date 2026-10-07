# UMS Payments: Cashfree Payment Module

A backend payment module for a University Management System (UMS/ERP), integrated with the
[Cashfree Payment Gateway](https://www.cashfree.com/docs/payments/online/intro) (PG API version `2025-01-01`).

It covers the full payment lifecycle: creating an order, hosted checkout, webhooks, verification,
reconciliation, cancellation, refunds, and notifying the ERP of every outcome.

**Stack:** NestJS 11 · TypeScript · PostgreSQL 16 · Prisma 6 · Docker

---

## Table of contents

1. [Quick start](#quick-start)
2. [Architecture](#architecture)
3. [Payment workflow](#payment-workflow)
4. [Status model](#status-model)
5. [API documentation](#api-documentation)
6. [Webhooks (Cashfree to UMS)](#webhooks-cashfree--ums)
7. [ERP notifications (UMS to ERP)](#erp-notifications-ums--erp)
8. [Database design](#database-design)
9. [Failure handling & edge cases](#failure-handling--edge-cases)
10. [Key design decisions](#key-design-decisions)
11. [Testing](#testing)
12. [Production checklist & scaling](#production-checklist--scaling)

---

## Quick start

### Prerequisites

- Node.js 20+ (tested on 22/24)
- Docker (for PostgreSQL)
- A Cashfree **sandbox** account: [merchant.cashfree.com](https://merchant.cashfree.com) → switch to *Test mode* → *Developers → API Keys*

### Run locally

```bash
# 1. Install dependencies
npm install

# 2. Start PostgreSQL (exposed on host port 5433 to avoid clashing with a local Postgres)
docker compose up -d postgres

# 3. Configure environment
cp .env.example .env
#    then set CASHFREE_CLIENT_ID / CASHFREE_CLIENT_SECRET (sandbox) and API_KEYS

# 4. Apply migrations and generate the Prisma client
npx prisma migrate deploy
npx prisma generate

# 5. Run
npm run start:dev
```

- API: `http://localhost:3000`
- Swagger UI: `http://localhost:3000/docs`
- Health: `http://localhost:3000/health`

### Run everything in Docker

```bash
cp .env.example .env   # fill in Cashfree sandbox keys
docker compose --profile app up --build
```

The API container runs `prisma migrate deploy` on start.

### Receiving sandbox webhooks locally

Cashfree must be able to reach your machine over HTTPS. Expose the API with a tunnel and point
`PUBLIC_BASE_URL` at it:

```bash
cloudflared tunnel --url http://localhost:3000     # or: ngrok http 3000
# PUBLIC_BASE_URL=https://<random>.trycloudflare.com
```

With an HTTPS `PUBLIC_BASE_URL` every order is created with a `notify_url`, so Cashfree sends
webhooks there automatically. You can also configure the URL in the Cashfree dashboard
(*Developers → Webhooks*): `https://<host>/api/v1/webhooks/cashfree`.

Even without webhooks the system still converges: the browser return URL and the reconciliation
job both pull the status from Cashfree.

### End-to-end sandbox walkthrough

```bash
# 1. ERP backend creates an order
curl -X POST http://localhost:3000/api/v1/payments/orders \
  -H "x-api-key: change-me-erp-api-key" \
  -H "Idempotency-Key: inv-2026-0001-attempt-1" \
  -H "content-type: application/json" \
  -d '{
    "studentId": "STU-1001",
    "feeReference": "INV-2026-0001",
    "purpose": "TUITION_FEE",
    "amount": 1500.00,
    "customer": { "name": "Asha Verma", "email": "asha@example.edu", "phone": "9876543210" }
  }'
# -> { "orderId": "UMS_...", "status": "ACTIVE", "checkout": { "paymentSessionId": "session_...", "environment": "sandbox" }, ... }

# 2. Frontend opens Cashfree checkout with the paymentSessionId (Cashfree JS SDK):
#    const cashfree = Cashfree({ mode: "sandbox" });
#    cashfree.checkout({ paymentSessionId, redirectTarget: "_self" });
#    Pay with a sandbox test instrument (e.g. UPI "testsuccess@gocash" or "testfailure@gocash").

# 3. After payment the browser is redirected to /api/v1/payments/return, which verifies the status
#    with Cashfree and redirects to DEFAULT_FRONTEND_RETURN_URL?order_id=...&status=PAID

# 4. ERP reads the final status
curl http://localhost:3000/api/v1/payments/orders/UMS_... -H "x-api-key: change-me-erp-api-key"
```

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | – | PostgreSQL connection string |
| `API_KEYS` | yes | – | Comma-separated keys accepted in `x-api-key` (allows rotation) |
| `CASHFREE_ENV` | | `sandbox` | `sandbox` or `production` |
| `CASHFREE_CLIENT_ID` / `CASHFREE_CLIENT_SECRET` | yes | – | Cashfree credentials (the secret also verifies webhooks) |
| `CASHFREE_API_VERSION` | | `2025-01-01` | `x-api-version` header |
| `CASHFREE_TIMEOUT_MS` | | `10000` | Per-request timeout to Cashfree |
| `PUBLIC_BASE_URL` | yes | – | Public URL of this service (builds `return_url` / `notify_url`) |
| `DEFAULT_FRONTEND_RETURN_URL` | yes | – | Where the browser goes after checkout |
| `ALLOWED_RETURN_ORIGINS` | | – | Origins allowed for a per-order `returnUrl` |
| `PAYMENT_ORDER_TTL_MINUTES` | | `30` | Order expiry sent to Cashfree (min 16) |
| `ERP_WEBHOOK_URL` / `ERP_WEBHOOK_SECRET` | | – | ERP endpoint for outcome events and its HMAC secret |
| `JOBS_ENABLED` | | `true` | Run reconciliation + outbox jobs in this instance |
| `RECONCILE_INTERVAL_SECONDS` | | `60` | Reconciliation tick |
| `RECONCILE_STALE_AFTER_SECONDS` | | `300` | Re-check open orders/refunds not synced for this long |
| `OUTBOX_INTERVAL_SECONDS` / `OUTBOX_MAX_ATTEMPTS` | | `10` / `10` | ERP delivery tick and retry budget |

The environment is validated at boot (`src/config/env.ts`). The app refuses to start if it's misconfigured.

---

## Architecture

```
 ┌──────────────┐  1. "pay fee INV-1"  ┌──────────────┐  2. POST /payments/orders  ┌──────────────────────────────┐
 │  Student UI  │ ───────────────────▶ │  ERP backend │ ─────────────────────────▶ │   UMS Payments (this repo)   │
 │  (browser)   │ ◀─────────────────── │              │ ◀───────────────────────── │                              │
 └──────┬───────┘  paymentSessionId    └──────▲───────┘    order + session         │  PaymentsController  (API key)│
        │                                     │                                    │  WebhooksController (HMAC)   │
        │ 3. Cashfree JS checkout             │ 8. payment.succeeded               │  ReturnController   (public) │
        ▼                                     │    (signed, retried)               │                              │
 ┌──────────────┐  4. redirect to return_url ─┼──────────────────────────────────▶ │  PaymentSyncService ◀── single│
 │   Cashfree   │  5. webhook (signed) ───────┼──────────────────────────────────▶ │  source of truth path        │
 │   Checkout   │ ◀── 6. GET order/payments ──┼─────────────────────────────────── │  PaymentStateService (FSM)   │
 └──────────────┘                             │                                    │  RefundsService              │
                                              │                                    │  ReconciliationService (cron)│
                                              │                                    │  OutboxDispatcher (cron) ────┘
                                              │                                    └──────────────┬───────────────┘
                                              │                                                   │ 7. state + audit + outbox
                                              └──────────────────────────────── outbox ◀──────────▼  (one transaction)
                                                                                           ┌──────────────┐
                                                                                           │  PostgreSQL  │
                                                                                           └──────────────┘
```

### Module layout

```
src/
├── main.ts                     # bootstrap (raw body for webhooks, validation, Swagger)
├── app.module.ts
├── config/                     # zod-validated env + typed AppConfig
├── prisma/                     # PrismaService
├── common/                     # API-key guard, Idempotency-Key decorator, crypto & money helpers, errors
├── cashfree/                   # Cashfree REST client, types, error classification, webhook signature
├── payments/
│   ├── domain/payment-state.ts # pure state machine + status derivation (unit tested)
│   ├── payment-state.service.ts# the ONLY writer of payment status (FSM + audit + outbox)
│   ├── payment-sync.service.ts # pulls Cashfree truth and applies it (used by every trigger)
│   ├── payments.service.ts     # create / get / list / verify / cancel / return-URL
│   ├── refunds.service.ts
│   ├── payments.controller.ts  # ERP-facing REST API
│   └── payment-return.controller.ts
├── webhooks/                   # Cashfree webhook inbox
├── outbox/                     # transactional outbox + ERP dispatcher
├── jobs/                       # reconciliation + scheduler
└── health/
prisma/
├── schema.prisma
└── migrations/                 # SQL migrations (incl. hand-written constraints)
test/                           # e2e suite with a fake Cashfree gateway
```

**Who calls what:**

- **ERP backend → payment module**, server-to-server with `x-api-key`. The browser never calls the
  create endpoint directly, because the amount must come from the ERP's invoice and not from the client.
- **Browser → Cashfree** for checkout using the `paymentSessionId` (card/UPI data never touches our servers,
  which keeps us out of PCI-DSS scope).
- **Cashfree → payment module**: webhooks (HMAC-signed) and the browser redirect to the return URL.
- **Payment module → ERP**: signed outcome events through the outbox.

---

## Payment workflow

```
ERP                     Payments module                          Cashfree                 Browser
 │ POST /orders (Idem-Key) │                                         │                        │
 │────────────────────────▶│ 1. dedupe: key / paid fee / open order  │                        │
 │                         │ 2. INSERT order (CREATED) + event       │                        │
 │                         │ 3. POST /pg/orders ────────────────────▶│                        │
 │                         │ ◀──────────── cf_order_id, session ─────│                        │
 │                         │ 4. CREATED → ACTIVE                     │                        │
 │◀──── 201 {orderId, checkout.paymentSessionId} ───────────────────────────────────────────▶│
 │                         │                                         │◀── 5. checkout ────────│
 │                         │◀──── 6a. webhook PAYMENT_*_WEBHOOK ─────│                        │
 │                         │      verify HMAC → store inbox → 200    │                        │
 │                         │ 7. GET /pg/orders/{id} + /payments ────▶│                        │
 │                         │ 8. lock row, derive status, FSM check,  │                        │
 │                         │    upsert attempts, audit, outbox (1 tx)│                        │
 │                         │◀──── 6b. browser redirect (return_url) ─────────────────────────│
 │                         │      same sync (7-8), then 302 to ERP UI ──────────────────────▶│
 │◀── 9. payment.succeeded (signed, at-least-once) ─ outbox dispatcher                        │
 │                         │                                         │                        │
 │                         │ 10. reconciliation job every minute: re-sync stale open orders,  │
 │                         │     resubmit unknown refunds, retry failed webhooks              │
```

1. **Create.** The ERP sends the fee details with an `Idempotency-Key`. The module checks idempotency,
   whether the fee is already paid, and whether an open order already exists for it. It then reserves
   a local row (`CREATED`) *before* calling Cashfree, so there's always a record of the attempt even if the
   process crashes mid-call.
2. **Initiate.** It calls `POST /pg/orders` with our own `order_id`, `return_url`, `notify_url`, an expiry
   and tags. On success the order moves to `ACTIVE` and the `payment_session_id` is returned to the ERP.
3. **Checkout.** The frontend opens Cashfree checkout with the session id. The customer can retry
   failed attempts on the same order until it expires.
4. **Updates.** Three independent triggers tell us something changed: the webhook, the browser return URL,
   and the reconciliation job. Each one only *triggers* a sync. The status always comes from
   `GET /orders/{id}` + `GET /orders/{id}/payments`.
5. **Apply.** Inside one DB transaction with a row lock: upsert each payment attempt, derive the status,
   validate the transition, write an audit event and an outbox event.
6. **Notify ERP.** The outbox dispatcher POSTs a signed event to the ERP and retries with exponential
   backoff until it gets a 2xx.
7. **Post-payment.** Refunds (partial or full) and cancellation of unpaid orders.

---

## Status model

| Status | Meaning | Customer can pay? | Terminal? |
|---|---|---|---|
| `CREATED` | Reserved locally; Cashfree order not confirmed yet | no | no |
| `ACTIVE` | Cashfree order live, no attempt yet | **yes** | no |
| `PENDING` | An attempt is pending at the bank (e.g. UPI collect) | no (blocks re-payment) | no |
| `FAILED` | Latest attempt failed; order still live | **yes** (retry) | no |
| `USER_DROPPED` | Latest attempt abandoned; order still live | **yes** (retry) | no |
| `PAID` | Money captured | no | for payment, yes |
| `PARTIALLY_REFUNDED` | Some money refunded | no | no |
| `REFUNDED` | Fully refunded | no | **yes** |
| `EXPIRED` | Order expired unpaid | no | yes* |
| `CANCELLED` | Terminated by the ERP | no | yes* |
| `INITIATION_FAILED` | Cashfree rejected / never created the order | no | yes* |

\* *Late success:* if Cashfree later reports a captured payment for an `EXPIRED`/`CANCELLED`/`INITIATION_FAILED`
order, it still moves to `PAID` (money did move) and is flagged `LATE_SUCCESS_AFTER_<status>` for review/refund.

```
CREATED ──▶ ACTIVE ──▶ PENDING ──▶ PAID ──▶ PARTIALLY_REFUNDED ──▶ REFUNDED
   │          │ ▲         │         ▲  └──────────────────────────────▲
   │          ▼ │         ▼         │
   │      FAILED / USER_DROPPED ────┘ (retry on same order)
   │          │
   ▼          ▼
INITIATION_FAILED   EXPIRED / CANCELLED ──(late success)──▶ PAID [flagged]
```

**Deriving the status from Cashfree** (`deriveStatus`), in order of precedence:

1. Any attempt `SUCCESS` → `PAID`
2. Any attempt `PENDING` → `PENDING` (even if the order expired, because the bank may still confirm)
3. Order `EXPIRED` → `EXPIRED`; `TERMINATED`/`TERMINATION_REQUESTED` → `CANCELLED`
4. Otherwise the latest attempt decides: `FAILED`/`VOID` → `FAILED`, `USER_DROPPED`/`CANCELLED` → `USER_DROPPED`, none → `ACTIVE`

Transitions are validated against an explicit allow-list (`src/payments/domain/payment-state.ts`).
A disallowed transition is logged and ignored. That's how a stale `PAYMENT_FAILED_WEBHOOK` arriving
after `PAID` is prevented from downgrading the order.

---

## API documentation

Base path: `/api/v1`. Interactive docs: **`/docs`** (Swagger).

**Auth:** ERP endpoints require the `x-api-key` header. The webhook is authenticated by HMAC signature. The return
URL is public and only redirects.

**Errors** use a consistent shape with a stable machine-readable `code`:

```json
{ "statusCode": 409, "code": "FEE_ALREADY_PAID", "message": "This fee has already been paid", "details": { "orderId": "UMS_..." } }
```

### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/payments/orders` | API key + `Idempotency-Key` | Create or return a payment order + checkout session |
| `GET` | `/payments/orders` | API key | List orders (`studentId`, `feeReference`, `status`, `page`, `pageSize`) |
| `GET` | `/payments/orders/:orderId` | API key | Order with payment attempts and refunds |
| `GET` | `/payments/orders/:orderId/events` | API key | Audit trail of status changes |
| `POST` | `/payments/orders/:orderId/verify` | API key | Force re-sync with Cashfree now |
| `POST` | `/payments/orders/:orderId/cancel` | API key | Terminate an unpaid order at Cashfree |
| `POST` | `/payments/orders/:orderId/refunds` | API key + `Idempotency-Key` | Create a (partial) refund |
| `GET` | `/payments/orders/:orderId/refunds/:refundId` | API key | Refund status |
| `GET` | `/payments/return?order_id=` | public | Cashfree `return_url`: verifies, then 302 to the frontend |
| `POST` | `/webhooks/cashfree` | HMAC signature | Cashfree webhook receiver |
| `GET` | `/health` | public | Liveness + DB check |

### `POST /api/v1/payments/orders`

Headers: `x-api-key`, `Idempotency-Key` (8–128 chars; e.g. `INV-2026-0001:attempt-1`).

```json
{
  "studentId": "STU-1001",
  "feeReference": "INV-2026-0001",
  "purpose": "TUITION_FEE",
  "amount": 45000.50,
  "currency": "INR",
  "customer": { "name": "Asha Verma", "email": "asha@example.edu", "phone": "9876543210" },
  "returnUrl": "https://erp.example.edu/fees/INV-2026-0001/result",
  "metadata": { "semester": "2026-ODD", "installment": 1 }
}
```

| Field | Rules |
|---|---|
| `studentId`, `feeReference` | required, 1–64 chars, `[A-Za-z0-9_-./:]` |
| `purpose` | required, 1–64 chars |
| `amount` | required, 1 to 10,000,000, max 2 decimals |
| `currency` | optional, `INR` |
| `customer.phone` | required (Cashfree requirement), 10–15 digits |
| `returnUrl` | optional, origin must be in `ALLOWED_RETURN_ORIGINS` |
| `metadata` | optional object, stored as-is |

**Responses**

- `201 Created`: new order
- `200 OK`: idempotent replay, or the existing open order for the same fee/student/amount was returned

```json
{
  "orderId": "UMS_MGG3H2K19C1F0A2B3C4D",
  "cfOrderId": "2149460581",
  "status": "ACTIVE",
  "studentId": "STU-1001",
  "feeReference": "INV-2026-0001",
  "purpose": "TUITION_FEE",
  "amount": "45000.50",
  "currency": "INR",
  "checkout": { "paymentSessionId": "session_a1VXIPJo8kh7...", "environment": "sandbox" },
  "expiresAt": "2026-10-07T12:30:00.000Z",
  "paidAt": null,
  "flaggedReason": null,
  "metadata": { "semester": "2026-ODD", "installment": 1 },
  "createdAt": "2026-10-07T12:00:00.000Z",
  "updatedAt": "2026-10-07T12:00:01.000Z"
}
```

`checkout` is only present while the customer can still pay (`ACTIVE`/`FAILED`/`USER_DROPPED`, not expired).
Amounts are returned as strings so no precision is lost.

| Error | HTTP | When |
|---|---|---|
| `IDEMPOTENCY_KEY_REUSED` | 422 | Same key, different body |
| `FEE_ALREADY_PAID` | 409 | Fee reference already settled |
| `PAYMENT_IN_PROGRESS` | 409 | An attempt for this fee is pending at the bank, so the customer must not pay twice |
| `OPEN_ORDER_EXISTS` | 409 | Another open order for this fee has different details (cancel it first) |
| `RETURN_URL_NOT_ALLOWED` | 400 | `returnUrl` origin not allow-listed |
| `GATEWAY_UNAVAILABLE` | 503 | Cashfree unreachable / outcome unknown. **Retry with the same Idempotency-Key** |
| `GATEWAY_REJECTED` | 502 | Cashfree rejected the order (order becomes `INITIATION_FAILED`) |

### `GET /api/v1/payments/orders/:orderId`

Returns the order (shape above) plus:

```json
{
  "transactions": [
    { "cfPaymentId": "5114910039112", "status": "FAILED", "amount": "45000.50", "paymentGroup": "upi",
      "bankReference": null, "message": "Insufficient balance", "paymentTime": "...", "completedAt": "..." },
    { "cfPaymentId": "5114910039178", "status": "SUCCESS", "amount": "45000.50", "paymentGroup": "upi",
      "bankReference": "234928698581", "message": "00::Transaction success", "paymentTime": "...", "completedAt": "..." }
  ],
  "refunds": [
    { "refundId": "RF_MGG3...", "cfRefundId": "11325632", "status": "SUCCESS", "amount": "10000.00",
      "reason": "Course withdrawal", "processedAt": "..." }
  ]
}
```

### `GET /api/v1/payments/orders?studentId=STU-1001&status=PAID&page=1&pageSize=20`

```json
{ "items": [ { "orderId": "...", "status": "PAID", "...": "..." } ], "total": 3, "page": 1, "pageSize": 20 }
```

### `POST /api/v1/payments/orders/:orderId/verify`

Re-fetches the status from Cashfree and returns the updated order. Use it when the ERP UI wants
certainty right now. It's never required for correctness, because webhooks and reconciliation converge anyway.

### `POST /api/v1/payments/orders/:orderId/cancel`

Terminates an unpaid order at Cashfree (`PATCH /pg/orders/{id}`), then re-reads the gateway state to confirm.
Idempotent for already-cancelled orders.
Errors: `PAYMENT_IN_PROGRESS` (pending attempt), `NOT_CANCELLABLE` (paid/expired, or a payment raced the cancel).

### `POST /api/v1/payments/orders/:orderId/refunds`

Headers: `x-api-key`, `Idempotency-Key`.

```json
{ "amount": 10000, "reason": "Course withdrawal" }
```

Response `201` (or `200` on replay):

```json
{ "refundId": "RF_MGG3...", "cfRefundId": "11325632", "status": "PENDING", "amount": "10000.00",
  "reason": "Course withdrawal", "statusDescription": null, "processedAt": null, "createdAt": "..." }
```

Errors: `NOT_REFUNDABLE` (409, order not paid), `REFUND_EXCEEDS_BALANCE` (422, includes `details.refundable`),
`IDEMPOTENCY_KEY_REUSED` (422).
Refund statuses: `PENDING`, `ONHOLD`, `SUCCESS`, `CANCELLED`, `FAILED` (never accepted by Cashfree).

### `GET /api/v1/payments/orders/:orderId/events`

```json
[
  { "fromStatus": null,     "toStatus": "CREATED", "source": "API",        "note": "Order reserved", "createdAt": "..." },
  { "fromStatus": "CREATED","toStatus": "ACTIVE",  "source": "API",        "note": "cashfree order_status=ACTIVE, attempts=0", "createdAt": "..." },
  { "fromStatus": "ACTIVE", "toStatus": "PAID",    "source": "WEBHOOK",    "note": "cashfree order_status=PAID, attempts=1", "createdAt": "..." }
]
```

### `GET /api/v1/payments/return?order_id=...`

Configured as the Cashfree `return_url`. It syncs the order and responds `302` to
`<order.returnUrl or DEFAULT_FRONTEND_RETURN_URL>?order_id=...&status=PAID`.
The `status` query param is only for display. The frontend must not use it to grant anything,
because the ERP learns the outcome server-side.

---

## Webhooks (Cashfree → UMS)

`POST /api/v1/webhooks/cashfree`. Configure it in the Cashfree dashboard, or let each order carry it as `notify_url`.

Processing pipeline:

1. **Verify signature** on the *raw* request bytes:
   `base64(HMAC_SHA256(x-webhook-timestamp + rawBody, CASHFREE_CLIENT_SECRET))`, compared in constant time.
   Invalid → `401` and nothing is stored.
2. **Persist** into `webhook_events` (the inbox), deduplicated by `sha256(rawBody)`. Cashfree retries send an
   identical body, so they collapse into one row.
3. **Process:**
   - `PAYMENT_SUCCESS_WEBHOOK` / `PAYMENT_FAILED_WEBHOOK` / `PAYMENT_USER_DROPPED_WEBHOOK` → `syncOrder(order_id)`
   - `REFUND_STATUS_WEBHOOK` → `syncRefund(refund_id)`
   - Unknown type or unknown order → stored as `IGNORED`
4. **Always `200`** once persisted, even if processing failed. Failed events are marked `FAILED` and retried by the
   reconciliation job (up to 10 attempts), so a temporary outage doesn't depend on Cashfree's retry schedule.

**Why we don't trust the webhook body:** the payload is used only to find *which* order changed.
The status is re-read from Cashfree's API. This makes out-of-order, duplicated, or replayed webhooks harmless.
A replayed old webhook just triggers a re-read of the current state, which is also why no timestamp-window
check is needed for replay protection.

---

## ERP notifications (UMS → ERP)

Every meaningful status change writes an `outbox_events` row **in the same transaction** as the change.
The dispatcher (every `OUTBOX_INTERVAL_SECONDS`) POSTs it to `ERP_WEBHOOK_URL`:

```
POST {ERP_WEBHOOK_URL}
x-ums-event-id: 6b0e...          # unique; the ERP must dedupe on it (at-least-once delivery)
x-ums-event-type: payment.succeeded
x-ums-signature: hex(HMAC_SHA256(body, ERP_WEBHOOK_SECRET))

{
  "id": "6b0e...",
  "type": "payment.succeeded",
  "occurredAt": "2026-10-07T12:03:10.000Z",
  "data": {
    "orderId": "UMS_...", "cfOrderId": "2149460581", "studentId": "STU-1001",
    "feeReference": "INV-2026-0001", "purpose": "TUITION_FEE", "status": "PAID",
    "amount": "45000.50", "currency": "INR", "paidAt": "2026-10-07T12:03:09.000Z", "flaggedReason": null
  }
}
```

Event types: `payment.pending`, `payment.succeeded`, `payment.failed`, `payment.dropped`, `payment.expired`,
`payment.cancelled`, `payment.initiation_failed`, `payment.partially_refunded`, `payment.refunded`,
`refund.succeeded`, `refund.failed`.

Retries use exponential backoff (5s, 10s, 20s, … capped at 1h). After `OUTBOX_MAX_ATTEMPTS` failures the event is
marked `DEAD` for alerting and manual replay. If `ERP_WEBHOOK_URL` is empty, events are only logged, and the ERP
can poll `GET /payments/orders` instead.

---

## Database design

Six tables, all `snake_case`, UUID primary keys, `timestamptz`, money as `DECIMAL(12,2)`.

```
payment_orders 1───* payment_transactions   (one row per Cashfree attempt, cf_payment_id unique)
       │ 1───* refunds                       (refund_id unique, idempotency_key unique)
       │ 1───* payment_events                (append-only audit trail)
webhook_events                               (inbox, dedupe_key unique)
outbox_events                                (ERP notifications, status + next_attempt_at)
```

| Table | Purpose | Key constraints |
|---|---|---|
| `payment_orders` | One payable order per checkout. Our `order_id` is the id at Cashfree too | `order_id` unique · `idempotency_key` unique · **partial unique index: one open order per `fee_reference`** · `amount > 0` · paid states require `paid_at` |
| `payment_transactions` | Every payment attempt (method, bank ref, error) mirrored from Cashfree | `cf_payment_id` unique (upsert target) |
| `refunds` | Merchant-initiated refunds | `refund_id` unique · `idempotency_key` unique · `amount > 0` |
| `payment_events` | Who changed what, when, and why (`API`/`WEBHOOK`/`RETURN_URL`/`RECONCILIATION`) | **append-only, enforced by a DB trigger** |
| `webhook_events` | Raw webhooks for dedupe, retry and audit | `dedupe_key` unique |
| `outbox_events` | Guaranteed ERP delivery | indexed on `(status, next_attempt_at)` |

The migration is in `prisma/migrations/20261007000000_init/migration.sql`. The bottom of that file contains
hand-written SQL for constraints Prisma's schema language can't express:

```sql
CREATE UNIQUE INDEX payment_orders_one_open_order_per_fee
  ON payment_orders(fee_reference)
  WHERE status IN ('CREATED','ACTIVE','PENDING','FAILED','USER_DROPPED');
```

That index is what makes "two browser tabs paying the same invoice at the same time" impossible, even across
multiple app instances. The application checks first for friendly errors, and the database guarantees it.

---

## Failure handling & edge cases

| Scenario | Handling |
|---|---|
| ERP retries create (network blip, double click) | Same `Idempotency-Key` + same body → same order (`200`). Different body → `422` |
| Two concurrent creates for one fee | Partial unique index lets one win. The loser re-resolves to the winner's order (tested with 6 parallel requests) |
| Cashfree times out on create | Outcome unknown, so we `GET` the order. If it exists we adopt it, otherwise `503` and the row stays `CREATED`. Retrying with the same key resumes. Our `order_id` is unique at Cashfree, so a retry can never create a second gateway order |
| Cashfree rejects create (4xx) | `INITIATION_FAILED` with the gateway message; a fresh attempt is allowed |
| Order stuck in `CREATED` (process crashed) | Reconciliation adopts it if Cashfree has it, else marks `INITIATION_FAILED` after a 2-min grace |
| Webhook lost / never configured | Return URL + reconciliation job converge the state |
| Webhook duplicated / retried | Dedupe by body hash; processing is idempotent anyway |
| Webhooks out of order (FAILED after SUCCESS) | Status re-read from Cashfree + state machine forbids `PAID → FAILED` |
| Forged webhook | HMAC verification on raw bytes, constant-time compare, `401` |
| Our DB/Cashfree down while processing a webhook | Event already persisted → `200`; marked `FAILED`; retried by the job |
| Customer's attempt fails / is abandoned | `FAILED`/`USER_DROPPED`; the same order and session stay payable until expiry |
| Bank says PENDING (UPI collect, net-banking) | `PENDING`; new orders for that fee are blocked (`PAYMENT_IN_PROGRESS`); cancel is refused; reconciliation keeps polling |
| Order expires unpaid | `EXPIRED` via webhook/reconciliation; a new order can be created |
| Payment succeeds *after* expiry/cancel | Recorded as `PAID`, flagged `LATE_SUCCESS_AFTER_*`, ERP notified |
| Same fee paid twice (two orders) | Second one flagged `DUPLICATE_PAYMENT: …` so it can be refunded |
| Gateway order amount differs from ours | Never marked `PAID`; flagged `AMOUNT_MISMATCH` and logged as an error |
| Cancel races with a payment | Cashfree refuses to terminate; we re-sync and return `NOT_CANCELLABLE` with the real status |
| Concurrent refunds over-refunding | Order row locked during the balance check; pending + successful refunds count against it |
| Refund call times out | Stays `PENDING` without `cf_refund_id`; reconciliation resubmits with the same `refund_id` (idempotent at Cashfree) |
| ERP endpoint down | Outbox retries with backoff, then `DEAD` for alerting |
| Webhook + return URL + job hit the same order at once | `SELECT … FOR UPDATE` serialises them; gateway I/O happens *before* taking the lock |
| Open redirect via `returnUrl` | Origin allow-list |
| Amount tampering from the browser | Create is server-to-server only (API key); the amount comes from the ERP invoice |

---

## Key design decisions

1. **The webhook is a trigger, not the truth.** Every signal (webhook, return URL, manual verify, cron) calls the
   same `PaymentSyncService.syncOrder`, which reads Cashfree's API. There's one code path to reason about and test,
   and ordering/duplication problems go away. The cost is one or two extra API calls per event, which is negligible at
   university scale.

2. **Explicit state machine with a single writer.** `PaymentStateService.transition` is the only code that changes
   `status`. It validates against an allow-list and writes the audit event and the outbox event atomically. Illegal
   transitions are ignored and logged, not thrown, because stale gateway signals are normal.

3. **Reserve locally, then call the gateway.** The local `CREATED` row is written before `POST /pg/orders`. There's
   always a record of the attempt, idempotent retries can resume it, and crashes are recoverable by reconciliation.

4. **Idempotency at every layer.** Client `Idempotency-Key` (with a request-hash check), merchant-generated
   `order_id`/`refund_id` (Cashfree rejects duplicates), webhook dedupe key, unique `cf_payment_id` upserts, and
   event ids for the ERP. Any message can be delivered twice without harm.

5. **Transactional outbox instead of calling the ERP inline.** Calling the ERP inside the webhook handler would
   couple our availability to theirs and risk "DB updated but ERP never told" or the reverse. The outbox makes the
   notification atomic with the state change and gives at-least-once delivery with retries.

6. **DB-enforced invariants.** The one-open-order-per-fee partial unique index, positive amount checks, the
   paid-requires-`paid_at` check, and the append-only audit trigger. App checks give good error messages, and the
   database guarantees correctness under concurrency and across instances.

7. **No Redis/BullMQ (yet).** Postgres row locks plus `FOR UPDATE SKIP LOCKED` claims give safe, multi-instance
   background processing with zero extra infrastructure. Payment volume for a university is bursty but modest
   (fee deadlines). BullMQ is the planned next step if webhook processing needs to move off the request path at
   higher volume (see scaling).

8. **Money is never a float.** `DECIMAL(12,2)` in Postgres, `Prisma.Decimal`/integer paise in code, strings in the API.

9. **No direct Cashfree SDK.** A thin typed `fetch` client (~100 lines) gives full control over timeouts, request ids,
   and transient vs definitive error classification (`CashfreeApiError.isTransient`), which drives the retry logic.
   It's also trivial to fake in tests and to put behind a gateway interface if a second PSP is added.

10. **Security.** Raw-body HMAC verification, constant-time comparisons, API keys that support rotation, an
    open-redirect allow-list, strict DTO validation (`forbidNonWhitelisted`), no card data stored (hosted checkout),
    secrets only via env, and no secrets/PII in logs.

---

## Testing

```bash
npm test            # unit tests: state machine, status derivation, webhook signature
npm run test:e2e    # e2e: real PostgreSQL + fake Cashfree (needs `docker compose up -d postgres`)
```

The e2e suite uses a separate database (`ums_payments_test`, created and migrated automatically; override with
`TEST_DATABASE_URL`) and an in-memory fake Cashfree that reproduces Cashfree's semantics: duplicate `order_id`
→ 409, 404s, timeouts, and lost responses. It covers:

- auth, validation, the open-redirect guard, forged webhooks
- create, idempotent replay, key reuse with a different body, open-order reuse, a 6-way concurrent create race
- gateway down → 503 → resume; timeout-after-success adoption; gateway rejection → `INITIATION_FAILED`
- success/failed/dropped/pending webhooks, duplicate webhooks, a stale failure after success, retry after failure
- webhook processing failure → retried by the job
- cancel (and idempotent re-cancel), expiry via reconciliation, late success flagged, return-URL redirect
- partial → full refunds, over-refund protection, refund resubmission after an unknown outcome
- ERP outbox delivery with HMAC signature, backoff on ERP failure

---

## Production checklist & scaling

**Before going live**

- Switch `CASHFREE_ENV=production`, use production keys, and whitelist the production return/notify domains in Cashfree.
- Serve over HTTPS behind a load balancer; keep `/api/v1/webhooks/cashfree` publicly reachable.
- Rotate `API_KEYS` / `ERP_WEBHOOK_SECRET` through a secrets manager.
- Alert on: `outbox_events.status = 'DEAD'`, `webhook_events.status = 'FAILED'` with max attempts, any
  `payment_orders.flagged_reason IS NOT NULL`, and orders stuck in `PENDING` for more than 24h.
- Run `prisma migrate deploy` as a release step (not on every replica boot).
- Add a daily settlement reconciliation against Cashfree's settlement report for finance.

**Scaling path (in order, only when needed)**

1. Run several API replicas; set `JOBS_ENABLED=true` on all (claims are `SKIP LOCKED`-safe) or on a dedicated worker.
2. Move webhook processing off the request path: persist, ack, and enqueue to **BullMQ (Redis)**. The inbox table
   already makes this a small change.
3. Rate-limit outbound Cashfree calls during fee-deadline spikes and add a circuit breaker.
4. Partition or archive `payment_events`, `webhook_events` and `outbox_events` by month.
5. Introduce a `PaymentGateway` interface if a second PSP (Razorpay, etc.) is added. `CashfreeClient` is already isolated.
