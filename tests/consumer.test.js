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

function makeMsg(event) {
  return {
    content: Buffer.from(JSON.stringify(event)),
    fields: { deliveryTag: 1 },
    properties: {},
  };
}

function createMockChannel() {
  return {
    assertQueue: jest.fn().mockResolvedValue({ queue: 'ai_events' }),
    prefetch: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn().mockResolvedValue({ consumerTag: 'test-tag' }),
    cancel: jest.fn().mockResolvedValue(undefined),
    ack: jest.fn(),
    nack: jest.fn(),
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
    it('parses valid JSON message', () => {
      const msg = makeMsg(VALID_EVENT);
      const result = parseMessage(msg);
      expect(result).toEqual(VALID_EVENT);
    });

    it('returns null for invalid JSON', () => {
      const msg = { content: Buffer.from('not json') };
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      expect(parseMessage(msg)).toBeNull();
      errorSpy.mockRestore();
    });

    it('returns null when client_id is missing', () => {
      const msg = makeMsg({ model: 'gpt-4' });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(parseMessage(msg)).toBeNull();
      warnSpy.mockRestore();
    });

    it('returns null when model is missing', () => {
      const msg = makeMsg({ client_id: 'test' });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(parseMessage(msg)).toBeNull();
      warnSpy.mockRestore();
    });
  });

  describe('createConsumer', () => {
    it('sets up queues with DLQ binding', async () => {
      const channel = createMockChannel();
      const dbPool = createMockDbPool();
      const consumer = createConsumer(channel, dbPool, { queue: 'ai_events', dlq: 'ai_events_dlq' });

      await consumer.setup();

      expect(channel.assertQueue).toHaveBeenCalledTimes(2);
      // Main queue with DLQ config
      expect(channel.assertQueue).toHaveBeenCalledWith('ai_events', expect.objectContaining({
        durable: true,
        arguments: expect.objectContaining({
          'x-dead-letter-routing-key': 'ai_events_dlq',
        }),
      }));
      // DLQ
      expect(channel.assertQueue).toHaveBeenCalledWith('ai_events_dlq', { durable: true });
    });

    it('sets prefetch count', async () => {
      const channel = createMockChannel();
      const consumer = createConsumer(channel, createMockDbPool(), { queue: 'q', dlq: 'dlq', prefetch: 5 });
      await consumer.setup();
      expect(channel.prefetch).toHaveBeenCalledWith(5);
    });

    it('starts consuming and returns consumer tag', async () => {
      const channel = createMockChannel();
      const consumer = createConsumer(channel, createMockDbPool(), { queue: 'q', dlq: 'dlq' });
      const tag = await consumer.start();
      expect(tag).toBe('test-tag');
      expect(channel.consume).toHaveBeenCalledWith('q', expect.any(Function));
    });

    it('stops consuming on stop()', async () => {
      const channel = createMockChannel();
      const consumer = createConsumer(channel, createMockDbPool(), { queue: 'q', dlq: 'dlq' });
      await consumer.start();
      await consumer.stop();
      expect(channel.cancel).toHaveBeenCalledWith('test-tag');
    });

    it('acks message after successful DB write', async () => {
      const channel = createMockChannel();
      const dbPool = createMockDbPool(true);
      const consumer = createConsumer(channel, dbPool, { queue: 'q', dlq: 'dlq' });
      const msg = makeMsg(VALID_EVENT);

      await consumer.handleMessage(msg);

      expect(dbPool.query).toHaveBeenCalledTimes(1);
      expect(channel.ack).toHaveBeenCalledWith(msg);
      expect(channel.nack).not.toHaveBeenCalled();
      expect(consumer.getStats().written).toBe(1);
    });

    it('nacks message to DLQ on DB write failure', async () => {
      const channel = createMockChannel();
      const dbPool = createMockDbPool(false);
      const consumer = createConsumer(channel, dbPool, { queue: 'q', dlq: 'dlq' });
      const msg = makeMsg(VALID_EVENT);

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      await consumer.handleMessage(msg);
      errorSpy.mockRestore();

      expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
      expect(channel.ack).not.toHaveBeenCalled();
      expect(consumer.getStats().failed).toBe(1);
    });

    it('acks and drops unparseable messages', async () => {
      const channel = createMockChannel();
      const dbPool = createMockDbPool();
      const consumer = createConsumer(channel, dbPool, { queue: 'q', dlq: 'dlq' });
      const msg = { content: Buffer.from('not json') };

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      await consumer.handleMessage(msg);
      errorSpy.mockRestore();

      expect(channel.ack).toHaveBeenCalledWith(msg);
      expect(dbPool.query).not.toHaveBeenCalled();
      expect(consumer.getStats().dropped).toBe(1);
    });

    it('tracks stats correctly across multiple messages', async () => {
      const channel = createMockChannel();
      let callCount = 0;
      const dbPool = {
        query: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 2) return Promise.reject(new Error('fail'));
          return Promise.resolve({ rowCount: 1 });
        }),
      };
      const consumer = createConsumer(channel, dbPool, { queue: 'q', dlq: 'dlq' });

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      await consumer.handleMessage(makeMsg(VALID_EVENT)); // success
      await consumer.handleMessage(makeMsg(VALID_EVENT)); // fail
      await consumer.handleMessage(makeMsg(VALID_EVENT)); // success
      errorSpy.mockRestore();

      const stats = consumer.getStats();
      expect(stats.processed).toBe(3);
      expect(stats.written).toBe(2);
      expect(stats.failed).toBe(1);
    });

    it('handles null message (consumer cancelled)', async () => {
      const channel = createMockChannel();
      const consumer = createConsumer(channel, createMockDbPool(), { queue: 'q', dlq: 'dlq' });
      await consumer.handleMessage(null);
      expect(channel.ack).not.toHaveBeenCalled();
      expect(channel.nack).not.toHaveBeenCalled();
    });
  });
});
