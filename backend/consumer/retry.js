/**
 * Retry logic with exponential backoff for DB writes.
 *
 * On transient DB failures (connection timeout, temporary unavailability),
 * retries with exponential backoff before sending to DLQ.
 *
 * Non-retryable errors (constraint violations, syntax errors) go to DLQ immediately.
 */

const DEFAULT_OPTIONS = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10000,
  // Jitter factor: 0 = no jitter, 1 = full jitter (up to 100% of delay)
  jitterFactor: 0.5,
};

// PostgreSQL error codes that indicate transient failures (worth retrying)
const RETRYABLE_PG_CODES = new Set([
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53000', // insufficient_resources
  '53100', // disk_full
  '53200', // out_of_memory
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);

// Error messages that indicate transient failures (for non-PG errors)
const RETRYABLE_MESSAGES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'connection terminated',
  'Connection terminated',
  'timeout expired',
];

/**
 * Determine if an error is retryable.
 */
function isRetryable(err) {
  // Check PG error code
  if (err.code && RETRYABLE_PG_CODES.has(err.code)) {
    return true;
  }

  // Check error message patterns
  const msg = err.message || '';
  return RETRYABLE_MESSAGES.some((pattern) => msg.includes(pattern));
}

/**
 * Calculate delay with exponential backoff + jitter.
 */
function calculateDelay(attempt, opts) {
  const { baseDelayMs, maxDelayMs, jitterFactor } = opts;
  const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  const jitter = exponentialDelay * jitterFactor * Math.random();
  return Math.round(exponentialDelay + jitter);
}

/**
 * Execute a function with retry logic.
 *
 * @param {function} fn — async function to execute
 * @param {object} opts — retry options (merged with defaults)
 * @returns {Promise<{ success: boolean, result?: any, error?: Error, attempts: number }>}
 */
async function withRetry(fn, opts = {}) {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const { maxRetries } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      return { success: true, result, attempts: attempt + 1 };
    } catch (err) {
      // Last attempt or non-retryable error → give up
      if (attempt >= maxRetries || !isRetryable(err)) {
        return { success: false, error: err, attempts: attempt + 1 };
      }

      const delay = calculateDelay(attempt, options);
      console.warn(`[retry] Attempt ${attempt + 1}/${maxRetries + 1} failed: ${err.message}. Retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // Should not reach here, but just in case
  return { success: false, error: new Error('Max retries exceeded'), attempts: maxRetries + 1 };
}

module.exports = { withRetry, isRetryable, calculateDelay, DEFAULT_OPTIONS, RETRYABLE_PG_CODES };
