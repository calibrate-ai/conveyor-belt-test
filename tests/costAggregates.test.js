const { validateParams, buildQuery, VALID_GRANULARITIES } = require('../backend/queries/costAggregates');

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('costAggregates query builder', () => {
  describe('validateParams', () => {
    it('accepts valid params with defaults', () => {
      const result = validateParams({ client_id: VALID_UUID });
      expect(result.valid).toBe(true);
      expect(result.params.clientId).toBe(VALID_UUID);
      expect(result.params.granularity).toBe('hour');
      expect(result.params.startTs).toBeInstanceOf(Date);
      expect(result.params.endTs).toBeInstanceOf(Date);
      expect(result.params.model).toBeNull();
    });

    it('normalizes client_id to lowercase', () => {
      const result = validateParams({ client_id: VALID_UUID.toUpperCase() });
      expect(result.valid).toBe(true);
      expect(result.params.clientId).toBe(VALID_UUID);
    });

    it('rejects missing client_id', () => {
      const result = validateParams({});
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('client_id is required');
    });

    it('rejects invalid client_id format', () => {
      const result = validateParams({ client_id: 'not-a-uuid' });
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.stringContaining('valid UUID'),
      ]));
    });

    it('accepts all valid granularities', () => {
      VALID_GRANULARITIES.forEach((g) => {
        const result = validateParams({ client_id: VALID_UUID, granularity: g });
        expect(result.valid).toBe(true);
        expect(result.params.granularity).toBe(g);
      });
    });

    it('rejects invalid granularity', () => {
      const result = validateParams({ client_id: VALID_UUID, granularity: 'minute' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/granularity/);
    });

    it('accepts valid ISO 8601 timestamps', () => {
      const result = validateParams({
        client_id: VALID_UUID,
        start_ts: '2026-04-01T00:00:00Z',
        end_ts: '2026-04-02T00:00:00Z',
      });
      expect(result.valid).toBe(true);
      expect(result.params.startTs.toISOString()).toBe('2026-04-01T00:00:00.000Z');
      expect(result.params.endTs.toISOString()).toBe('2026-04-02T00:00:00.000Z');
    });

    it('rejects invalid start_ts', () => {
      const result = validateParams({ client_id: VALID_UUID, start_ts: 'garbage' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/start_ts/);
    });

    it('rejects invalid end_ts', () => {
      const result = validateParams({ client_id: VALID_UUID, end_ts: 'garbage' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/end_ts/);
    });

    it('rejects start_ts >= end_ts', () => {
      const result = validateParams({
        client_id: VALID_UUID,
        start_ts: '2026-04-02T00:00:00Z',
        end_ts: '2026-04-01T00:00:00Z',
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.stringContaining('before'),
      ]));
    });

    it('accepts optional model filter', () => {
      const result = validateParams({ client_id: VALID_UUID, model: 'gpt-4' });
      expect(result.valid).toBe(true);
      expect(result.params.model).toBe('gpt-4');
    });

    it('collects multiple errors', () => {
      const result = validateParams({
        granularity: 'minute',
        start_ts: 'bad',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });
  });

  describe('buildQuery', () => {
    const baseParams = {
      clientId: VALID_UUID,
      granularity: 'hour',
      startTs: new Date('2026-04-01T00:00:00Z'),
      endTs: new Date('2026-04-02T00:00:00Z'),
      model: null,
    };

    it('builds a parameterized query for hour granularity', () => {
      const { sql, values } = buildQuery(baseParams);
      expect(sql).toContain('cost_rollup_hourly');
      expect(sql).toContain('$1');
      expect(sql).toContain('$2');
      expect(sql).toContain('$3');
      expect(values).toEqual([VALID_UUID, '2026-04-01T00:00:00.000Z', '2026-04-02T00:00:00.000Z']);
    });

    it('reads directly from continuous aggregate for hour granularity', () => {
      const { sql } = buildQuery(baseParams);
      expect(sql).toContain('FROM cost_rollup_hourly');
      expect(sql).not.toContain('GROUP BY'); // direct read, no re-bucketing
    });

    it('re-buckets for day granularity', () => {
      const { sql } = buildQuery({ ...baseParams, granularity: 'day' });
      expect(sql).toContain("time_bucket('1 day'");
      expect(sql).toContain('GROUP BY');
      expect(sql).toContain('SUM(');
    });

    it('re-buckets for week granularity', () => {
      const { sql } = buildQuery({ ...baseParams, granularity: 'week' });
      expect(sql).toContain("time_bucket('1 week'");
      expect(sql).toContain('GROUP BY');
    });

    it('adds model filter when specified', () => {
      const { sql, values } = buildQuery({ ...baseParams, model: 'gpt-4' });
      expect(sql).toContain('AND model = $4');
      expect(values).toContain('gpt-4');
      expect(values.length).toBe(4);
    });

    it('does not add model filter when null', () => {
      const { sql, values } = buildQuery(baseParams);
      expect(sql).not.toContain('AND model =');
      expect(values.length).toBe(3);
    });

    it('orders results by period DESC', () => {
      const { sql } = buildQuery(baseParams);
      expect(sql).toMatch(/ORDER BY.*DESC/);
    });

    it('scopes query by client_id ($1)', () => {
      const { sql } = buildQuery(baseParams);
      expect(sql).toContain('client_id = $1');
    });

    it('includes cost and token columns', () => {
      const { sql } = buildQuery(baseParams);
      expect(sql).toMatch(/cost_usd/);
      expect(sql).toMatch(/prompt_tokens/);
      expect(sql).toMatch(/completion_tokens/);
      expect(sql).toMatch(/request_count/);
    });

    it('uses parameterized values (no SQL injection)', () => {
      const malicious = {
        ...baseParams,
        clientId: "'; DROP TABLE requests; --",
      };
      const { sql, values } = buildQuery(malicious);
      // The malicious string should be in values, not interpolated in SQL
      expect(sql).not.toContain('DROP TABLE');
      expect(values[0]).toContain('DROP TABLE');
    });
  });
});
