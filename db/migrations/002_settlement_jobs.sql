CREATE TABLE IF NOT EXISTS settlement_jobs (
  id            bigserial   PRIMARY KEY,
  order_id      uuid        NOT NULL REFERENCES orders(id),
  attempts      int         NOT NULL DEFAULT 0,
  available_at  timestamptz NOT NULL DEFAULT now(),
  locked_at     timestamptz,
  traceparent   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Claimable jobs only: the partial index is what keeps the SKIP LOCKED claim cheap.
CREATE INDEX IF NOT EXISTS settlement_jobs_claimable
  ON settlement_jobs (available_at) WHERE locked_at IS NULL;
