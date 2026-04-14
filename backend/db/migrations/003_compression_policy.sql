-- Migration 003: Enable TimescaleDB compression on the requests hypertable
-- Depends on: 001_create_requests_hypertable.sql
--
-- Compresses chunks older than 7 days. Compressed data is still queryable
-- but uses significantly less disk space (typically 90%+ reduction).
--
-- Compression settings:
-- - segment_by: client_id (queries almost always filter by tenant)
-- - orderby: ts DESC (time-range queries are the primary access pattern)
--
-- The compression policy runs automatically. Manual compression of a
-- specific chunk is also possible:
--   SELECT compress_chunk('<chunk_name>');
--
-- To decompress (e.g. for backfill or correction):
--   SELECT decompress_chunk('<chunk_name>');

BEGIN;

-- Enable compression on the requests hypertable
ALTER TABLE requests SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'client_id',
  timescaledb.compress_orderby = 'ts DESC'
);

-- Add compression policy: compress chunks older than 7 days
-- This runs automatically via TimescaleDB's background worker
SELECT add_compression_policy(
  'requests',
  compress_after => INTERVAL '7 days',
  if_not_exists => TRUE
);

COMMIT;
