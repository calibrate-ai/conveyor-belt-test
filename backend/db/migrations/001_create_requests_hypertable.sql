-- Migration 001: Create requests hypertable with cost_usd column
-- Requires: TimescaleDB extension enabled on the target database
--
-- Usage:
--   psql -d calibrate -f backend/db/migrations/001_create_requests_hypertable.sql

BEGIN;

-- Enable TimescaleDB if not already enabled
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Main requests table — stores every proxied LLM request
CREATE TABLE IF NOT EXISTS requests (
    id              BIGSERIAL,
    ts              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    client_id       UUID            NOT NULL,
    model           TEXT            NOT NULL,
    provider        TEXT            NOT NULL,
    prompt_tokens   INTEGER         NOT NULL DEFAULT 0,
    completion_tokens INTEGER       NOT NULL DEFAULT 0,
    total_tokens    INTEGER         NOT NULL DEFAULT 0,
    cost_usd        NUMERIC(12, 6) NOT NULL DEFAULT 0,
    latency_ms      INTEGER         NOT NULL DEFAULT 0,
    status_code     SMALLINT        NOT NULL DEFAULT 200,
    error_code      TEXT,
    request_hash    TEXT,
    metadata        JSONB,

    PRIMARY KEY (id, ts)
);

-- Convert to hypertable — partition by ts (1-day chunks)
-- if_not_exists prevents error on re-run
SELECT create_hypertable(
    'requests',
    'ts',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_requests_client_id_ts
    ON requests (client_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_requests_model_ts
    ON requests (model, ts DESC);

CREATE INDEX IF NOT EXISTS idx_requests_client_model_ts
    ON requests (client_id, model, ts DESC);

CREATE INDEX IF NOT EXISTS idx_requests_status_code_ts
    ON requests (status_code, ts DESC);

CREATE INDEX IF NOT EXISTS idx_requests_request_hash
    ON requests (request_hash)
    WHERE request_hash IS NOT NULL;

COMMIT;
