const { createConsumer, parseMessage } = require('../backend/consumer/consumer');

const VALID_EVENT = {
  client_id: '550e8400-e29b-41d4-a716-446655440000',
  model: 'gpt-4',
  provider: 'openai',
  prompt_tokens: 100,
  completion_tokens: 50,
  total_tokens: 150,
  cost_usd: 0.006,
  latency_ms: 250,
  status_code: 200,
};

function createMockRedis() {
  return {
    blpop: jest.fn().mockResolvedValue(null),
    rpush: jest.fn().mockResolvedValue(1),
  };
}

function createMockDbPool(success = true) {
  return {
    query: success
      ? jest.fn().mockResolvedValue({ rowCount: 1 })
      : jest.fn().mockRejectedValue(new Error('DB error')),
  };
}

describe('consumer', () => {
  describe('parseMessage', () => {
    it('parses valid JSON string', () => {
      const result = parseMessage(JSON.stringify(VALID_EVENT));
      expect(result).toEqual(VALID_EVENT);
    });

    it('returns null for invalid JSON', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      expect(parseMessage('not json')).toBeNull();
      errorSpy.mockRestore();
    });

    it('returns null when client_id is missing', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(parseMessage(JSON.stringify({ model: 'gpt-4' }))).toBeNull();
      warnSpy.mockRestore();
    });

    it('returns null when model is missing', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(parseMessage(JSON.stringify({ client_id: 'test' }))).toBeNull();
      warnSpy.mockRestore();
    });
  });

  describe('createConsumer', () => {
    it('processOne writes valid event to DB', async () => {
      const redis = createMockRedis();
      const dbPool = createMockDbPool(true);
      const consumer = createConsumer(redis, dbPool, { queue: 'q', dlq: 'dlq' });

      const result = await consumer.processOne(JSON.stringify(VALID_EVENT));
      expect(result).toBe('written');
      expect(dbPool.query).toHaveBeenCalledTimes(1);
      expect(consumer.getStats().written).toBe(1);
    });

    it('processOne pushes to DLQ on DB failure', async () => {
      const redis = createMockRedis();
      const dbPool = createMockDbPool(false);
      const consumer = createConsumer(redis, dbPool, { queue: 'q', dlq: 'dlq' });

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const result = await consumer.processOne(JSON.stringify(VALID_EVENT));
      errorSpy.mockRestore();

      expect(result).toBe('failed');
      expect(redis.rpush).toHaveBeenCalledWith('dlq', JSON.stringify(VALID_EVENT));
      expect(consumer.getStats().failed).toBe(1);
    });

    it('processOne drops unparseable messages', async () => {
      const redis = createMockRedis();
      const dbPool = createMockDbPool();
      const consumer = createConsumer(redis, dbPool, { queue: 'q', dlq: 'dlq' });

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const result = await consumer.processOne('not json');
      errorSpy.mockRestore();

      expect(result).toBe('dropped');
      expect(dbPool.query).not.toHaveBeenCalled();
      expect(redis.rpush).not.toHaveBeenCalled();
      expect(consumer.getStats().dropped).toBe(1);
    });

    it('processOne drops messages missing required fields', async () => {
      const redis = createMockRedis();
      const dbPool = createMockDbPool();
      const consumer = createConsumer(redis, dbPool, { queue: 'q', dlq: 'dlq' });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await consumer.processOne(JSON.stringify({ model: 'gpt-4' }));
      warnSpy.mockRestore();

      expect(result).toBe('dropped');
      expect(consumer.getStats().dropped).toBe(1);
    });

    it('tracks stats correctly across multiple messages', async () => {
      const redis = createMockRedis();
      let callCount = 0;
      const dbPool = {
        query: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 2) return Promise.reject(new Error('fail'));
          return Promise.resolve({ rowCount: 1 });
        }),
      };
      const consumer = createConsumer(redis, dbPool, { queue: 'q', dlq: 'dlq' });

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      await consumer.processOne(JSON.stringify(VALID_EVENT)); // success
      await consumer.processOne(JSON.stringify(VALID_EVENT)); // fail
      await consumer.processOne(JSON.stringify(VALID_EVENT)); // success
      errorSpy.mockRestore();

      const stats = consumer.getStats();
      expect(stats.processed).toBe(3);
      expect(stats.written).toBe(2);
      expect(stats.failed).toBe(1);
    });

    it('stop() sets running to false', () => {
      const consumer = createConsumer(createMockRedis(), createMockDbPool(), { queue: 'q', dlq: 'dlq' });
      expect(consumer.isRunning()).toBe(false);
      consumer.stop();
      expect(consumer.isRunning()).toBe(false);
    });

    it('handles DLQ push failure gracefully', async () => {
      const redis = {
        blpop: jest.fn(),
        rpush: jest.fn().mockRejectedValue(new Error('DLQ error')),
      };
      const dbPool = createMockDbPool(false);
      const consumer = createConsumer(redis, dbPool, { queue: 'q', dlq: 'dlq' });

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const result = await consumer.processOne(JSON.stringify(VALID_EVENT));
      errorSpy.mockRestore();

      // Should still return 'failed' even if DLQ push also fails
      expect(result).toBe('failed');
      expect(consumer.getStats().failed).toBe(1);
    });
  });
});
