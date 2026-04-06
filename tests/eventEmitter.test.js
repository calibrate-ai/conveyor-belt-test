const { createEmitter } = require('../backend/lib/eventEmitter');

describe('eventEmitter', () => {
  it('publishes event to redis queue', async () => {
    const mockRedis = { rpush: jest.fn().mockResolvedValue(1) };
    const { emit, QUEUE_NAME } = createEmitter(mockRedis);

    const event = { model: 'gpt-4', cost_usd: 0.05 };
    const result = await emit(event);

    expect(result).toBe(true);
    expect(mockRedis.rpush).toHaveBeenCalledTimes(1);
    expect(mockRedis.rpush).toHaveBeenCalledWith(QUEUE_NAME, expect.any(String));

    const payload = JSON.parse(mockRedis.rpush.mock.calls[0][1]);
    expect(payload.model).toBe('gpt-4');
    expect(payload.queued_at).toBeDefined();
  });

  it('returns false and logs error when redis fails (fail-open)', async () => {
    const mockRedis = { rpush: jest.fn().mockRejectedValue(new Error('connection refused')) };
    const { emit } = createEmitter(mockRedis);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await emit({ model: 'gpt-4' });

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/Failed to emit/);
    errorSpy.mockRestore();
  });

  it('adds queued_at timestamp to payload', async () => {
    const mockRedis = { rpush: jest.fn().mockResolvedValue(1) };
    const { emit } = createEmitter(mockRedis);

    await emit({ model: 'gpt-4' });
    const payload = JSON.parse(mockRedis.rpush.mock.calls[0][1]);
    const ts = new Date(payload.queued_at);
    expect(ts.toISOString()).toBe(payload.queued_at);
  });

  it('serializes event to JSON', async () => {
    const mockRedis = { rpush: jest.fn().mockResolvedValue(1) };
    const { emit } = createEmitter(mockRedis);

    const event = { model: 'gpt-4', cost_usd: 0.123456, metadata: { key: 'value' } };
    await emit(event);
    const raw = mockRedis.rpush.mock.calls[0][1];
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
