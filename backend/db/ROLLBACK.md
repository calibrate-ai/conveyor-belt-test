# Migration Rollback Guide

Rollbacks are manual. The migration runner only supports forward migrations.

## Rolling Back Migrations

### 003_compression_policy.sql

```sql
-- Remove compression policy
SELECT remove_compression_policy('requests', if_not_exists => TRUE);
-- Decompress all compressed chunks (may take time for large datasets)
SELECT decompress_chunk(c) FROM show_chunks('requests', older_than => INTERVAL '7 days') c;
-- Disable compression on the table
ALTER TABLE requests SET (timescaledb.compress = false);
-- Remove tracking entry
DELETE FROM _migrations WHERE name = '003_compression_policy.sql';
```

### 002_create_cost_rollup_view.sql

```sql
-- Remove refresh policy first
SELECT remove_continuous_aggregate_policy('cost_rollup_hourly', if_exists => TRUE);
-- Drop the view
DROP MATERIALIZED VIEW IF EXISTS cost_rollup_hourly;
-- Remove tracking entry
DELETE FROM _migrations WHERE name = '002_create_cost_rollup_view.sql';
```

### 001_create_requests_hypertable.sql

⚠️ **This drops all request data. Ensure backups exist.**

```sql
-- Remove retention policy
SELECT remove_retention_policy('requests', if_exists => TRUE);
-- Drop hypertable (cascades chunks)
DROP TABLE IF EXISTS requests CASCADE;
-- Remove tracking entry
DELETE FROM _migrations WHERE name = '001_create_requests_hypertable.sql';
```

## Notes

- Always take a `pg_dump` before rolling back.
- Continuous aggregates must be dropped before their source hypertable.
- The `_migrations` table is not dropped by rollbacks — it's infrastructure.
