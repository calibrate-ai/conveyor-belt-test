/**
 * Event emitter — publishes request events to a Redis queue
 * for async DB write by the consumer service.
 *
 * Fail-open design: if Redis is down or the emit fails,
 * the error is logged but the request is NOT blocked.
 *
 * Queue: ai_events (configurable via REDIS_QUEUE_NAME env var)
 */

const QUEUE_NAME = process.env.REDIS_QUEUE_NAME || 'ai_events';

/**
 * Create an event emitter that publishes to a Redis client.
 *
 * @param {object} redisClient - Redis client with rpush() method
 * @returns {function} emit(event) — resolves true on success, false on failure
 */
function createEmitter(redisClient) {
  /**
   * Emit a request event to the queue.
   * Never throws — always resolves.
   *
   * @param {object} event - Request event payload
   * @returns {Promise<boolean>} true if published, false if failed
   */
  async function emit(event) {
    try {
      const payload = JSON.stringify({
        ...event,
        queued_at: new Date().toISOString(),
      });
      await redisClient.rpush(QUEUE_NAME, payload);
      return true;
    } catch (err) {
      // Fail open — log the error, don't block the request
      console.error(`[eventEmitter] Failed to emit to ${QUEUE_NAME}:`, err.message);
      return false;
    }
  }

  return { emit, QUEUE_NAME };
}

module.exports = { createEmitter };
