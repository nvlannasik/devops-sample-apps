-- Migration 001: initial schema
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS orders (
  id            uuid        PRIMARY KEY,
  customer_id   text        NOT NULL,
  items         jsonb       NOT NULL,
  amount_cents  bigint      NOT NULL,
  status        text        NOT NULL CHECK (status IN ('placed','settled','failed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settlement_jobs (
  id            bigserial   PRIMARY KEY,
  order_id      uuid        NOT NULL REFERENCES orders(id),
  attempts      int         NOT NULL DEFAULT 0,
  available_at  timestamptz NOT NULL DEFAULT now(),
  locked_at     timestamptz,
  traceparent   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS settlement_jobs_claimable
  ON settlement_jobs (available_at) WHERE locked_at IS NULL;

-- schema_version table lets MIGRATION_REQUIRED verify at boot
CREATE TABLE IF NOT EXISTS schema_version (
  version int PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;
