const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const dbConfig = require('../backend/db/config');

describe('Database schema migrations', () => {
  let migrationFiles;

  beforeAll(() => {
    migrationFiles = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  });

  it('has migration files in the migrations directory', () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
  });

  it('migration files are numbered sequentially', () => {
    migrationFiles.forEach((file, i) => {
      const num = parseInt(file.split('_')[0], 10);
      expect(num).toBe(i + 1);
    });
  });

  it('all migration files are valid UTF-8 SQL', () => {
    migrationFiles.forEach((file) => {
      const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      expect(content.length).toBeGreaterThan(0);
      // Basic SQL sanity: should contain at least one statement
      expect(content).toMatch(/\b(CREATE|ALTER|INSERT|SELECT|BEGIN|DROP)\b/i);
    });
  });

  describe('001_create_requests_hypertable.sql', () => {
    let sql;

    beforeAll(() => {
      sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '001_create_requests_hypertable.sql'), 'utf8');
    });

    it('creates the requests table', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS requests/i);
    });

    it('includes cost_usd column with NUMERIC type', () => {
      expect(sql).toMatch(/cost_usd\s+NUMERIC\(\d+,\s*\d+\)/i);
    });

    it('includes client_id as UUID NOT NULL', () => {
      expect(sql).toMatch(/client_id\s+UUID\s+NOT NULL/i);
    });

    it('includes model column', () => {
      expect(sql).toMatch(/model\s+TEXT\s+NOT NULL/i);
    });

    it('creates hypertable with 1-day chunks', () => {
      expect(sql).toMatch(/create_hypertable/i);
      expect(sql).toMatch(/1 day/i);
    });

    it('creates index on client_id + ts', () => {
      expect(sql).toMatch(/idx_requests_client_id_ts/i);
    });

    it('creates index on model + ts', () => {
      expect(sql).toMatch(/idx_requests_model_ts/i);
    });

    it('wraps in a transaction', () => {
      expect(sql).toMatch(/^BEGIN;/m);
      expect(sql).toMatch(/^COMMIT;/m);
    });

    it('includes all required columns for cost tracking', () => {
      const requiredColumns = [
        'client_id', 'model', 'provider', 'cost_usd',
        'prompt_tokens', 'completion_tokens', 'total_tokens',
        'latency_ms', 'status_code',
      ];
      requiredColumns.forEach((col) => {
        expect(sql).toContain(col);
      });
    });

    it('uses IF NOT EXISTS for idempotency', () => {
      expect(sql).toMatch(/IF NOT EXISTS/gi);
    });
  });

  describe('002_create_cost_rollup_view.sql', () => {
    let sql;

    beforeAll(() => {
      sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '002_create_cost_rollup_view.sql'), 'utf8');
    });

    it('creates continuous aggregate view', () => {
      expect(sql).toMatch(/CREATE MATERIALIZED VIEW.*cost_rollup_hourly/i);
      expect(sql).toMatch(/timescaledb\.continuous/i);
    });

    it('uses 1-hour time buckets', () => {
      expect(sql).toMatch(/time_bucket\('1 hour'/i);
    });

    it('groups by client_id and model', () => {
      expect(sql).toMatch(/client_id/);
      expect(sql).toMatch(/model/);
    });

    it('aggregates cost_usd', () => {
      expect(sql).toMatch(/SUM\(cost_usd\)/i);
    });

    it('includes latency percentiles', () => {
      expect(sql).toMatch(/PERCENTILE_CONT\(0\.50\)/i);
      expect(sql).toMatch(/PERCENTILE_CONT\(0\.95\)/i);
      expect(sql).toMatch(/PERCENTILE_CONT\(0\.99\)/i);
    });

    it('includes error count', () => {
      expect(sql).toMatch(/FILTER.*WHERE status_code >= 400/i);
    });

    it('sets up continuous aggregate refresh policy', () => {
      expect(sql).toMatch(/add_continuous_aggregate_policy/i);
      expect(sql).toMatch(/schedule_interval.*1 hour/i);
    });

    it('creates indexes on the rollup view', () => {
      expect(sql).toMatch(/idx_cost_rollup_client_bucket/i);
      expect(sql).toMatch(/idx_cost_rollup_model_bucket/i);
    });

    it('wraps in a transaction', () => {
      expect(sql).toMatch(/^BEGIN;/m);
      expect(sql).toMatch(/^COMMIT;/m);
    });
  });

  describe('db/config.js', () => {
    it('reads from environment variables', () => {
      expect(dbConfig.host).toBeDefined();
      expect(dbConfig.port).toBeDefined();
      expect(dbConfig.database).toBeDefined();
      expect(dbConfig.user).toBeDefined();
    });

    it('does not hardcode a password', () => {
      // DB_PASSWORD should come from env — no default
      const configSource = fs.readFileSync(
        path.join(__dirname, '..', 'backend', 'db', 'config.js'),
        'utf8'
      );
      // Should NOT have a string default for password
      expect(configSource).not.toMatch(/password.*['"][^'"]+['"]/);
    });

    it('has connection pool settings', () => {
      expect(dbConfig.pool).toBeDefined();
      expect(dbConfig.pool.min).toBeGreaterThan(0);
      expect(dbConfig.pool.max).toBeGreaterThan(dbConfig.pool.min);
    });
  });
});
