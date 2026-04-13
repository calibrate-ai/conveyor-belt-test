/**
 * Consumer configuration — all from environment variables.
 * DB config imported from shared module to avoid duplication.
 */

const dbConfig = require('../db/config');

module.exports = {
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    queue: process.env.REDIS_QUEUE_NAME || 'ai_events',
    dlq: process.env.REDIS_DLQ_NAME || 'ai_events_dlq',
    // BLPOP timeout in seconds (0 = block forever)
    blockTimeoutSec: parseInt(process.env.REDIS_BLOCK_TIMEOUT, 10) || 5,
  },
  db: dbConfig,
  consumer: {
    // Max messages to accumulate before flushing as batch
    batchSize: parseInt(process.env.CONSUMER_BATCH_SIZE, 10) || 1,
    // Max ms to wait before flushing an incomplete batch
    batchFlushMs: parseInt(process.env.CONSUMER_BATCH_FLUSH_MS, 10) || 1000,
  },
};
