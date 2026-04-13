/**
 * Redis consumer service — reads ai_events list via BLPOP, writes to TimescaleDB.
 *
 * Matches the publisher in PR #8 (eventEmitter.js) which uses ioredis.rpush()
 * to publish to the ai_events Redis list.
 *
 * Design:
 * - BLPOP blocks until a message is available (with configurable timeout)
 * - On successful DB write: message is consumed (BLPOP already removed it)
 * - On DB write failure: push to DLQ list for later inspection
 * - Graceful shutdown on SIGTERM/SIGINT
 *
 * NOTE: Reconnection is handled by the process manager (systemd/k8s restart policy).
 * The consumer exits on unrecoverable errors so the orchestrator can restart it.
 *
 * Usage:
 *   REDIS_URL=redis://... DB_PASSWORD=... node backend/consumer/consumer.js
 */

const { insertOne } = require('./writer');

/**
 * Parse and validate a queue message.
 * Returns the parsed event or null if invalid.
 */
function parseMessage(raw) {
  try {
    const event = JSON.parse(raw);

    // Minimum required fields
    if (!event.client_id || !event.model) {
      console.warn('[consumer] Dropping message: missing client_id or model', {
        fields: Object.keys(event),
      });
      return null;
    }

    return event;
  } catch (err) {
    console.error('[consumer] Failed to parse message:', err.message);
    return null;
  }
}

/**
 * Create the consumer.
 *
 * @param {object} redisClient — ioredis client with blpop/rpush
 * @param {object} dbPool — pg Pool
 * @param {object} opts — { queue, dlq, blockTimeoutSec }
 * @returns {object} { start, stop, getStats, processOne }
 */
function createConsumer(redisClient, dbPool, opts) {
  const { queue, dlq, blockTimeoutSec = 5 } = opts;

  const stats = {
    processed: 0,
    written: 0,
    failed: 0,
    dropped: 0,
  };

  let running = false;

  /**
   * Process a single raw message string.
   * Returns 'written' | 'failed' | 'dropped'.
   */
  async function processOne(raw) {
    stats.processed++;
    const event = parseMessage(raw);

    if (!event) {
      stats.dropped++;
      return 'dropped';
    }

    try {
      await insertOne(dbPool, event);
      stats.written++;
      return 'written';
    } catch (err) {
      stats.failed++;
      console.error('[consumer] DB write failed, pushing to DLQ:', err.message);
      try {
        await redisClient.rpush(dlq, raw);
      } catch (dlqErr) {
        console.error('[consumer] Failed to push to DLQ:', dlqErr.message);
      }
      return 'failed';
    }
  }

  /**
   * Main consume loop — blocks on BLPOP until stopped.
   */
  async function start() {
    running = true;
    console.log(`[consumer] Consuming from Redis list "${queue}" (timeout=${blockTimeoutSec}s)`);

    while (running) {
      try {
        // BLPOP returns [key, value] or null on timeout
        const result = await redisClient.blpop(queue, blockTimeoutSec);
        if (!result) continue; // timeout, loop back

        const [, raw] = result;
        await processOne(raw);
      } catch (err) {
        if (!running) break; // shutdown in progress
        console.error('[consumer] Error in consume loop:', err.message);
        // Brief pause before retrying to avoid tight error loop
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    console.log('[consumer] Stopped consuming');
  }

  function stop() {
    running = false;
  }

  function getStats() {
    return { ...stats };
  }

  function isRunning() {
    return running;
  }

  return { start, stop, getStats, processOne, isRunning };
}

module.exports = { createConsumer, parseMessage };
