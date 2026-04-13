const { withRetry, isRetryable, calculateDelay, DEFAULT_OPTIONS, RETRYABLE_PG_CODES } = require('../backend/consumer/retry');

describe('retry', () => {
  describe('isRetryable', () => {
    it('returns true for retryable PG error codes', () => {
      RETRYABLE_PG_CODES.forEach((code) => {
        expect(isRetryable({ code })).toBe(true);
      });
    });

    it('returns true for connection error messages', () => {
      expect(isRetryable({ message: 'connect ECONNREFUSED 127.0.0.1:5432' })).toBe(true);
      expect(isRetryable({ message: 'Connection terminated unexpectedly' })).toBe(true);
      expect(isRetryable({ message: 'timeout expired' })).toBe(true);
      expect(isRetryable({ message: 'read ECONNRESET' })).toBe(true);
      expect(isRetryable({ message: 'connect ETIMEDOUT' })).toBe(true);
    });

    it('returns false for constraint violations', () => {
      expect(isRetryable({ code: '23505', message: 'unique violation' })).toBe(false);
    });

    it('returns false for syntax errors', () => {
      expect(isRetryable({ code: '42601', message: 'syntax error' })).toBe(false);
    });

    it('returns false for generic errors', () => {
      expect(isRetryable({ message: 'some random error' })).toBe(false);
      expect(isRetryable(new Error('unknown'))).toBe(false);
    });
  });

  describe('calculateDelay', () => {
    it('increases exponentially', () => {
      const opts = { baseDelayMs: 100, maxDelayMs: 10000, jitterFactor: 0 };
      expect(calculateDelay(0, opts)).toBe(100);
      expect(calculateDelay(1, opts)).toBe(200);
      expect(calculateDelay(2, opts)).toBe(400);
      expect(calculateDelay(3, opts)).toBe(800);
    });

    it('caps at maxDelayMs', () => {
      const opts = { baseDelayMs: 1000, maxDelayMs: 5000, jitterFactor: 0 };
      expect(calculateDelay(10, opts)).toBe(5000);
    });

    it('adds jitter when factor > 0', () => {
      const opts = { baseDelayMs: 1000, maxDelayMs: 10000, jitterFactor: 1 };
      const delays = new Set();
      for (let i = 0; i < 20; i++) {
        delays.add(calculateDelay(0, opts));
      }
      // With jitter, we should get multiple different values
      expect(delays.size).toBeGreaterThan(1);
    });

    it('returns base delay with zero jitter', () => {
      const opts = { baseDelayMs: 500, maxDelayMs: 10000, jitterFactor: 0 };
      expect(calculateDelay(0, opts)).toBe(500);
    });
  });

  describe('withRetry', () => {
    it('returns success on first attempt', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      const result = await withRetry(fn, { maxRetries: 3 });
      expect(result.success).toBe(true);
      expect(result.result).toBe('ok');
      expect(result.attempts).toBe(1);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on retryable error and succeeds', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce({ message: 'connect ECONNREFUSED', code: '08006' })
        .mockResolvedValue('ok');

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10, jitterFactor: 0 });
      warnSpy.mockRestore();

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('gives up after maxRetries on retryable errors', async () => {
      const err = { message: 'connect ECONNREFUSED', code: '08006' };
      const fn = jest.fn().mockRejectedValue(err);

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 10, jitterFactor: 0 });
      warnSpy.mockRestore();

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3); // initial + 2 retries
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('does NOT retry non-retryable errors', async () => {
      const err = { code: '23505', message: 'unique violation' };
      const fn = jest.fn().mockRejectedValue(err);

      const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('returns the error on failure', async () => {
      const err = new Error('final failure');
      const fn = jest.fn().mockRejectedValue(err);

      const result = await withRetry(fn, { maxRetries: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toBe(err);
    });

    it('uses default options when none provided', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      const result = await withRetry(fn);
      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
    });
  });

  describe('DEFAULT_OPTIONS', () => {
    it('has sensible defaults', () => {
      expect(DEFAULT_OPTIONS.maxRetries).toBeGreaterThan(0);
      expect(DEFAULT_OPTIONS.baseDelayMs).toBeGreaterThan(0);
      expect(DEFAULT_OPTIONS.maxDelayMs).toBeGreaterThan(DEFAULT_OPTIONS.baseDelayMs);
      expect(DEFAULT_OPTIONS.jitterFactor).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_OPTIONS.jitterFactor).toBeLessThanOrEqual(1);
    });
  });
});
