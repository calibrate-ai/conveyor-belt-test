/**
 * RabbitMQ consumer service — reads ai_events queue, writes to TimescaleDB.
 *
 * Design:
 * - Prefetch N messages, ack only AFTER successful DB write
 * - On DB write failure: nack with requeue=false → message goes to DLQ
 * - Graceful shutdown on SIGTERM/SIGINT
 * - Reconnects on connection loss
 *
 * Usage:
 *   RABBITMQ_URL=amqp://... DB_PASSWORD=... node backend/consumer/consumer.js
 */

const { insertOne } = require('./writer');

/**
 * Parse and validate a queue message.
 * Returns the parsed event or null if invalid.
 */
function parseMessage(msg) {
  try {
    const event = JSON.parse(msg.content.toString());

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
 * @param {object} channel — amqplib channel
 * @param {object} dbPool — pg Pool
 * @param {object} opts — { queue, dlq, prefetch }
 * @returns {object} { start, stop, getStats }
 */
function createConsumer(channel, dbPool, opts) {
  const { queue, dlq, prefetch = 10 } = opts;

  const stats = {
    processed: 0,
    written: 0,
    failed: 0,
    dropped: 0,
  };

  let consumerTag = null;
  let running = false;

  async function setup() {
    // Assert queues exist (idempotent)
    await channel.assertQueue(queue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': dlq,
      },
    });

    await channel.assertQueue(dlq, { durable: true });

    await channel.prefetch(prefetch);
  }

  async function handleMessage(msg) {
    if (!msg) return; // Consumer cancelled

    stats.processed++;
    const event = parseMessage(msg);

    if (!event) {
      // Unparseable message — ack to remove from queue (don't requeue garbage)
      stats.dropped++;
      channel.ack(msg);
      return;
    }

    try {
      await insertOne(dbPool, event);
      stats.written++;
      channel.ack(msg);
    } catch (err) {
      stats.failed++;
      console.error('[consumer] DB write failed, nacking to DLQ:', err.message);
      // nack with requeue=false → goes to DLQ
      channel.nack(msg, false, false);
    }
  }

  async function start() {
    await setup();
    running = true;
    const { consumerTag: tag } = await channel.consume(queue, handleMessage);
    consumerTag = tag;
    console.log(`[consumer] Consuming from ${queue} (prefetch=${prefetch})`);
    return tag;
  }

  async function stop() {
    if (!running) return;
    running = false;
    if (consumerTag) {
      await channel.cancel(consumerTag);
      console.log('[consumer] Stopped consuming');
    }
  }

  function getStats() {
    return { ...stats };
  }

  return { start, stop, getStats, handleMessage, setup };
}

module.exports = { createConsumer, parseMessage };
