const { insertOne, insertBatch, buildInsertSql, INSERT_COLUMNS } = require('../backend/consumer/writer');

const VALID_EVENT = {
  ts: '2026-04-13T00:00:00.000Z',
  client_id: '550e8400-e29b-41d4-a716-446655440000',
  model: 'gpt-4',
  provider: 'openai',
  prompt_tokens: 100,
  completion_tokens: 50,
  total_tokens: 150,
  cost_usd: 0.006,
  latency_ms: 250,
  status_code: 200,
  error_code: null,
  request_hash: 'abc123',
  metadata: null,
};

describe('writer', () => {
  describe('INSERT_COLUMNS', () => {
    it('has 13 columns matching the requests table', () => {
      expect(INSERT_COLUMNS).toHaveLength(13);
      expect(INSERT_COLUMNS).toContain('client_id');
      expect(INSERT_COLUMNS).toContain('cost_usd');
      expect(INSERT_COLUMNS).toContain('model');
    });
  });

  describe('buildInsertSql', () => {
    it('returns correct number of placeholders and values', () => {
      const { placeholders, values } = buildInsertSql(VALID_EVENT);
      expect(placeholders).toHaveLength(INSERT_COLUMNS.length);
      expect(values).toHaveLength(INSERT_COLUMNS.length);
    });

    it('uses 1-based parameter indices', () => {
      const { placeholders } = buildInsertSql(VALID_EVENT);
      expect(placeholders[0]).toBe('$1');
      expect(placeholders[12]).toBe('$13');
    });

    it('applies offset for batch inserts', () => {
      const { placeholders } = buildInsertSql(VALID_EVENT, 13);
      expect(placeholders[0]).toBe('$14');
      expect(placeholders[12]).toBe('$26');
    });

    it('defaults missing fields', () => {
      const { values } = buildInsertSql({ client_id: 'test', model: 'gpt-4' });
      // provider defaults to 'unknown'
      expect(values[3]).toBe('unknown');
      // tokens default to 0
      expect(values[4]).toBe(0);
      expect(values[5]).toBe(0);
      expect(values[6]).toBe(0);
    });

    it('serializes metadata to JSON string', () => {
      const event = { ...VALID_EVENT, metadata: { key: 'value' } };
      const { values } = buildInsertSql(event);
      expect(values[12]).toBe('{"key":"value"}');
    });
  });

  describe('insertOne', () => {
    it('calls dbPool.query with parameterized INSERT', async () => {
      const mockPool = { query: jest.fn().mockResolvedValue({ rowCount: 1 }) };
      const result = await insertOne(mockPool, VALID_EVENT);
      expect(result).toBe(true);
      expect(mockPool.query).toHaveBeenCalledTimes(1);
      const [sql, values] = mockPool.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO requests');
      expect(sql).toContain('$1');
      expect(values).toHaveLength(INSERT_COLUMNS.length);
    });

    it('throws on DB error (caller handles)', async () => {
      const mockPool = { query: jest.fn().mockRejectedValue(new Error('connection refused')) };
      await expect(insertOne(mockPool, VALID_EVENT)).rejects.toThrow('connection refused');
    });
  });

  describe('insertBatch', () => {
    it('inserts multiple events in a single query', async () => {
      const mockPool = { query: jest.fn().mockResolvedValue({ rowCount: 3 }) };
      const events = [VALID_EVENT, VALID_EVENT, VALID_EVENT];
      const count = await insertBatch(mockPool, events);
      expect(count).toBe(3);
      expect(mockPool.query).toHaveBeenCalledTimes(1);
      const [sql, values] = mockPool.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO requests');
      expect(values).toHaveLength(INSERT_COLUMNS.length * 3);
    });

    it('returns 0 for empty array', async () => {
      const mockPool = { query: jest.fn() };
      const count = await insertBatch(mockPool, []);
      expect(count).toBe(0);
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('uses correct parameter offsets for each row', async () => {
      const mockPool = { query: jest.fn().mockResolvedValue({ rowCount: 2 }) };
      await insertBatch(mockPool, [VALID_EVENT, VALID_EVENT]);
      const [sql] = mockPool.query.mock.calls[0];
      // First row: $1..$13, second row: $14..$26
      expect(sql).toContain('$1');
      expect(sql).toContain('$14');
      expect(sql).toContain('$26');
    });
  });
});
