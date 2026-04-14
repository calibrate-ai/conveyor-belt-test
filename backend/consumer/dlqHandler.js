/**
 * DLQ handler — processes events in ai_events_dlq.
 *
 * Events land in the DLQ when:
 * - DB writes fail after all retries are exhausted
 * - The consumer nacks a message
 *
 * The DLQ handler:
 * 1. Reads events from the DLQ list
 * 2. Logs each event as a structured alert (for log aggregation / alerting)
 * 3. Optionally retries the DB write (with a separate retry policy)
 * 4. Moves permanently failed events to a dead archive list
 *
 * Events are NEVER silently dropped. Every DLQ event is logged and accounted for.
 *
 * Usage:
 *   REDIS_URL=redis://... DB_PASSWORD=... node backend/consumer/dlqHandler.js
 */

const { insertOne } = require('./writer');
const { withRetry } = require('./retry');

/**
 * Emit a structured DLQ alert to stderr.
 * This should integrate with your alerting pipeline (PagerDuty, Slack, etc.)
 */
function emitDlqAlert(event, reason, raw) {
  const alert = {
    level: 'alert',
    code: 'DLQ-001',
    type: 'dlq_event',
    reason,
    client_id: event?.client_id || 'unknown',
    model: event?.model || 'unknown',
    ts: event?.ts || null,
    dlq_processed_at: new Date().toISOString(),
  };
  console.error(JSON.stringify(alert));
  return alert;
}

/**
 * Create the DLQ handler.
 *
 * @param {object} redisClient — ioredis client
 * @param {object} dbPool — pg Pool (for retry writes)
 * @param {object} opts — { dlq, archive, retryWrites, retryOptions }
 */
function createDlqHandler(redisClient, dbPool, opts) {
  const {
    dlq = 'ai_events_dlq',
    archive = 'ai_events_dead',
    retryWrites = true,
    retryOptions = { maxRetries: 1, baseDelayMs: 1000, jitterFactor: 0 },
  } = opts;

  const stats = {
    processed: 0,
    recovered: 0,
    archived: 0,
    unparseable: 0,
  };

  /**
   * Process a single DLQ message.
   * Returns 'recovered' | 'archived' | 'unparseable'.
   */
  async function processOne(raw) {
    stats.processed++;

    let event;
    try {
      event = JSON.parse(raw);
    } catch (err) {
      stats.unparseable++;
      emitDlqAlert(null, 'unparseable_message', raw);
      // Archive unparseable messages — don't lose them
      await safeArchive(raw);
      return 'unparseable';
    }

    // Always log the DLQ event
    emitDlqAlert(event, 'db_write_failed', raw);

    // Optionally retry the DB write
    if (retryWrites && event.client_id && event.model) {
      const { success } = await withRetry(
        () => insertOne(dbPool, event),
        retryOptions,
      );

      if (success) {
        stats.recovered++;
        return 'recovered';
      }
    }

    // Permanently failed — archive
    await safeArchive(raw);
    stats.archived++;
    return 'archived';
  }

  /**
   * Archive a message to the dead archive list.
   * Never throws — archive failures are logged but don't block processing.
   */
  async function safeArchive(raw) {
    try {
      await redisClient.rpush(archive, raw);
    } catch (err) {
      console.error('[dlqHandler] Failed to archive message:', err.message);
    }
  }

  /**
   * Drain the DLQ — process all current messages.
   * Returns the number of messages processed.
   *
   * This is designed to be called periodically (cron) or on-demand,
   * NOT as a continuous loop.
   */
  async function drain() {
    let count = 0;

    while (true) {
      // LPOP (non-blocking) — returns null when list is empty
      const raw = await redisClient.lpop(dlq);
      if (!raw) break;

      await processOne(raw);
      count++;
    }

    return count;
  }

  function getStats() {
    return { ...stats };
  }

  return { processOne, drain, getStats, safeArchive };
}

module.exports = { createDlqHandler, emitDlqAlert };
