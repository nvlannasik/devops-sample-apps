CREATE TABLE IF NOT EXISTS orders (
  id            uuid PRIMARY KEY,
  customer_id   text        NOT NULL,
  items         jsonb       NOT NULL,
  amount_cents  bigint      NOT NULL,
  status        text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_created_at ON orders (created_at DESC);
