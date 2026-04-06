-- Migration 002: Continuous aggregate for cost rollups
-- Depends on: 001_create_requests_hypertable.sql
--
-- Creates an hourly materialized view aggregating costs by client_id + model.
-- TimescaleDB will automatically refresh this as new data arrives.

BEGIN;

-- Hourly cost rollup — the primary view for /api/v1/usage/costs
CREATE MATERIALIZED VIEW IF NOT EXISTS cost_rollup_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', ts)   AS bucket,
    client_id,
    model,
    provider,
    COUNT(*)                    AS request_count,
    SUM(cost_usd)               AS total_cost_usd,
    SUM(prompt_tokens)          AS total_prompt_tokens,
    SUM(completion_tokens)      AS total_completion_tokens,
    SUM(total_tokens)           AS total_tokens,
    AVG(latency_ms)             AS avg_latency_ms,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY latency_ms) AS p50_latency_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms,
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) AS p99_latency_ms,
    COUNT(*) FILTER (WHERE status_code >= 400) AS error_count
WITH NO DATA;

-- Add refresh policy: refresh every hour, covering the last 3 hours
-- (overlap ensures late-arriving data is captured)
SELECT add_continuous_aggregate_policy(
    'cost_rollup_hourly',
    start_offset    => INTERVAL '3 hours',
    end_offset      => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists   => TRUE
);

-- Index on the rollup for fast tenant + time range queries
CREATE INDEX IF NOT EXISTS idx_cost_rollup_client_bucket
    ON cost_rollup_hourly (client_id, bucket DESC);

CREATE INDEX IF NOT EXISTS idx_cost_rollup_model_bucket
    ON cost_rollup_hourly (model, bucket DESC);

COMMIT;
