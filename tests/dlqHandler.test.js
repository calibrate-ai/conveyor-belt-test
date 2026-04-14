const { createDlqHandler, emitDlqAlert } = require('../backend/consumer/dlqHandler');

const VALID_EVENT = {
  client_id: '550e8400-e29b-41d4-a716-446655440000',
  model: 'gpt-4',
  provider: 'openai',
  prompt_tokens: 100,
  completion_tokens: 50,
  total_tokens: 150,
  cost_usd: 0.006,
  ts: '2026-04-13T00:00:00.000Z',
};

function createMockRedis(dlqMessages = []) {
  const queue = [...dlqMessages];
  return {
    lpop: jest.fn().mockImplementation(() => Promise.resolve(queue.shift() || null)),
    rpush: jest.fn().mockResolvedValue(1),
  };
}

function createMockDbPool(success = true) {
  return {
    query: success
      ? jest.fn().mockResolvedValue({ rowCount: 1 })
      : jest.fn().mockRejectedValue(new Error('DB still down')),
  };
}

describe('dlqHandler', () => {
  describe('emitDlqAlert', () => {
    it('logs structured alert to stderr', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const alert = emitDlqAlert(VALID_EVENT, 'db_write_failed', '{}');
      expect(alert.level).toBe('alert');
      expect(alert.code).toBe('DLQ-001');
      expect(alert.type).toBe('dlq_event');
      expect(alert.reason).toBe('db_write_failed');
      expect(alert.client_id).toBe(VALID_EVENT.client_id);
      expect(alert.dlq_processed_at).toBeDefined();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    });

    it('handles null event gracefully', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const alert = emitDlqAlert(null, 'unparseable', 'garbage');
      expect(alert.client_id).toBe('unknown');
      expect(alert.model).toBe('unknown');
      errorSpy.mockRestore();
    });
  });

  describe('processOne', () => {
    it('recovers event by retrying DB write', async () => {
      const redis = createMockRedis();
      const dbPool = createMockDbPool(true);
      const handler = createDlqHandler(redis, dbPool, { retryWrites: true, retryOptions: { maxRetries: 0 } });

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const result = await handler.processOne(JSON.stringify(VALID_EVENT));
      errorSpy.mockRestore();

      expect(result).toBe('recovered');
      expect(dbPool.query).toHaveBeenCalledTimes(1);
      expect(handler.getStats().recovered).toBe(1);
      // Should NOT archive recovered events
      expect(redis.rpush).not.toHaveBeenCalled();
    });

    it('archives event when retry also fails', async () => {
      const redis = createMockRedis();
      const dbPool = createMockDbPool(false);
      const handler = createDlqHandler(redis, dbPool, { retryWrites: true, retryOptions: { maxRetries: 0 } });

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const result = await handler.processOne(JSON.stringify(VALID_EVENT));
      errorSpy.mockRestore();

      expect(result).toBe('archived');
      expect(redis.rpush).toHaveBeenCalledWith('ai_events_dead', JSON.stringify(VALID_EVENT));
      expect(handler.getStats().archived).toBe(1);
    });

    it('archives unparseable messages', async () => {
      const redis = createMockRedis();
      const dbPool = createMockDbPool();
      const handler = createDlqHandler(redis, dbPool, {});

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const result = await handler.processOne('not json');
      errorSpy.mockRestore();

      expect(result).toBe('unparseable');
      expect(redis.rpush).toHaveBeenCalledWith('ai_events_dead', 'not json');
      expect(handler.getStats().unparseable).toBe(1);
    });

    it('skips retry when retryWrites is false', async () => {
      const redis = createMockRedis();
      const dbPool = createMockDbPool(true);
      const handler = createDlqHandler(redis, dbPool, { retryWrites: false });

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const result = await handler.processOne(JSON.stringify(VALID_EVENT));
      errorSpy.mockRestore();

      expect(result).toBe('archived');
      expect(dbPool.query).not.toHaveBeenCalled();
    });

    it('always logs an alert for every DLQ event', async () => {
      const redis = createMockRedis();
      const dbPool = createMockDbPool(true);
      const handler = createDlqHandler(redis, dbPool, { retryWrites: true, retryOptions: { maxRetries: 0 } });

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      await handler.processOne(JSON.stringify(VALID_EVENT));
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(errorSpy.mock.calls[0][0]);
      expect(logged.level).toBe('alert');
      expect(logged.code).toBe('DLQ-001');
      errorSpy.mockRestore();
    });

    it('handles archive failure gracefully', async () => {
      const redis = {
        lpop: jest.fn(),
        rpush: jest.fn().mockRejectedValue(new Error('archive error')),
      };
      const dbPool = createMockDbPool(false);
      const handler = createDlqHandler(redis, dbPool, { retryWrites: true, retryOptions: { maxRetries: 0 } });

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const result = await handler.processOne(JSON.stringify(VALID_EVENT));
      errorSpy.mockRestore();

      // Should still return 'archived' (attempted) even if archive push failed
      expect(result).toBe('archived');
    });
  });

  describe('drain', () => {
    it('processes all messages in DLQ', async () => {
      const messages = [
        JSON.stringify(VALID_EVENT),
        JSON.stringify({ ...VALID_EVENT, model: 'claude-3-opus' }),
        JSON.stringify({ ...VALID_EVENT, model: 'gemini-1.5-pro' }),
      ];
      const redis = createMockRedis(messages);
      const dbPool = createMockDbPool(true);
      const handler = createDlqHandler(redis, dbPool, { retryWrites: true, retryOptions: { maxRetries: 0 } });

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const count = await handler.drain();
      errorSpy.mockRestore();

      expect(count).toBe(3);
      expect(handler.getStats().processed).toBe(3);
      expect(handler.getStats().recovered).toBe(3);
    });

    it('returns 0 for empty DLQ', async () => {
      const redis = createMockRedis([]);
      const handler = createDlqHandler(redis, createMockDbPool(), {});
      const count = await handler.drain();
      expect(count).toBe(0);
    });

    it('handles mixed results (recover + archive)', async () => {
      const messages = [
        JSON.stringify(VALID_EVENT),
        'not json',
        JSON.stringify(VALID_EVENT),
      ];
      const redis = createMockRedis(messages);
      const dbPool = createMockDbPool(true);
      const handler = createDlqHandler(redis, dbPool, { retryWrites: true, retryOptions: { maxRetries: 0 } });

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const count = await handler.drain();
      errorSpy.mockRestore();

      expect(count).toBe(3);
      expect(handler.getStats().recovered).toBe(2);
      expect(handler.getStats().unparseable).toBe(1);
    });
  });
});
