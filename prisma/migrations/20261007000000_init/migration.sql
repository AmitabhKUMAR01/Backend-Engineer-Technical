-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'ACTIVE', 'PENDING', 'FAILED', 'USER_DROPPED', 'PAID', 'EXPIRED', 'CANCELLED', 'INITIATION_FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('SUCCESS', 'NOT_ATTEMPTED', 'PENDING', 'FAILED', 'USER_DROPPED', 'CANCELLED', 'VOID', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'ONHOLD', 'SUCCESS', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "EventSource" AS ENUM ('API', 'WEBHOOK', 'RETURN_URL', 'RECONCILIATION');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'DEAD');

-- CreateTable
CREATE TABLE "payment_orders" (
    "id" UUID NOT NULL,
    "order_id" VARCHAR(45) NOT NULL,
    "cf_order_id" VARCHAR(64),
    "student_id" VARCHAR(64) NOT NULL,
    "fee_reference" VARCHAR(64) NOT NULL,
    "purpose" VARCHAR(64) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "cf_order_status" VARCHAR(32),
    "payment_session_id" TEXT,
    "customer_name" VARCHAR(100),
    "customer_email" VARCHAR(254),
    "customer_phone" VARCHAR(20) NOT NULL,
    "return_url" TEXT,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "metadata" JSONB,
    "flagged_reason" VARCHAR(255),
    "last_gateway_error" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "last_synced_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" UUID NOT NULL,
    "payment_order_id" UUID NOT NULL,
    "cf_payment_id" VARCHAR(64) NOT NULL,
    "status" "TransactionStatus" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "payment_group" VARCHAR(64),
    "bank_reference" VARCHAR(128),
    "message" TEXT,
    "error_details" JSONB,
    "payment_time" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "raw" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "payment_order_id" UUID NOT NULL,
    "refund_id" VARCHAR(40) NOT NULL,
    "cf_refund_id" VARCHAR(64),
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(100),
    "idempotency_key" VARCHAR(128) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status_description" TEXT,
    "last_gateway_error" TEXT,
    "processed_at" TIMESTAMPTZ(3),
    "last_synced_at" TIMESTAMPTZ(3),
    "raw" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" UUID NOT NULL,
    "payment_order_id" UUID NOT NULL,
    "from_status" "PaymentStatus",
    "to_status" "PaymentStatus" NOT NULL,
    "source" "EventSource" NOT NULL,
    "note" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "dedupe_key" CHAR(64) NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "order_id" VARCHAR(45),
    "status" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "aggregate_id" VARCHAR(64) NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMPTZ(3),
    "locked_until" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_order_id_key" ON "payment_orders"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_idempotency_key_key" ON "payment_orders"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_orders_student_id_created_at_idx" ON "payment_orders"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_orders_fee_reference_idx" ON "payment_orders"("fee_reference");

-- CreateIndex
CREATE INDEX "payment_orders_status_last_synced_at_idx" ON "payment_orders"("status", "last_synced_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_cf_payment_id_key" ON "payment_transactions"("cf_payment_id");

-- CreateIndex
CREATE INDEX "payment_transactions_payment_order_id_idx" ON "payment_transactions"("payment_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_refund_id_key" ON "refunds"("refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_idempotency_key_key" ON "refunds"("idempotency_key");

-- CreateIndex
CREATE INDEX "refunds_payment_order_id_idx" ON "refunds"("payment_order_id");

-- CreateIndex
CREATE INDEX "refunds_status_last_synced_at_idx" ON "refunds"("status", "last_synced_at");

-- CreateIndex
CREATE INDEX "payment_events_payment_order_id_created_at_idx" ON "payment_events"("payment_order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_dedupe_key_key" ON "webhook_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "webhook_events_status_received_at_idx" ON "webhook_events"("status", "received_at");

-- CreateIndex
CREATE INDEX "webhook_events_order_id_idx" ON "webhook_events"("order_id");

-- CreateIndex
CREATE INDEX "outbox_events_status_next_attempt_at_idx" ON "outbox_events"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_id_idx" ON "outbox_events"("aggregate_id");

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_payment_order_id_fkey" FOREIGN KEY ("payment_order_id") REFERENCES "payment_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_order_id_fkey" FOREIGN KEY ("payment_order_id") REFERENCES "payment_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_order_id_fkey" FOREIGN KEY ("payment_order_id") REFERENCES "payment_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written constraints (not expressible in schema.prisma)
-- ---------------------------------------------------------------------------

-- At most one open (payable) order per ERP fee reference. Prevents two
-- concurrent checkouts for the same invoice even under race conditions.
CREATE UNIQUE INDEX "payment_orders_one_open_order_per_fee"
  ON "payment_orders"("fee_reference")
  WHERE "status" IN ('CREATED', 'ACTIVE', 'PENDING', 'FAILED', 'USER_DROPPED');

-- Money must always be positive.
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_positive" CHECK ("amount" > 0);

-- Paid states must carry a paid timestamp.
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_paid_at_required"
  CHECK ("status" NOT IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED') OR "paid_at" IS NOT NULL);

-- Payment events are an append-only audit log.
CREATE OR REPLACE FUNCTION "payment_events_block_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payment_events_append_only"
  BEFORE UPDATE OR DELETE ON "payment_events"
  FOR EACH ROW EXECUTE FUNCTION "payment_events_block_mutation"();
