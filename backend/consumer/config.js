/**
 * Consumer configuration — all from environment variables.
 */

module.exports = {
  rabbitmq: {
    url: process.env.RABBITMQ_URL || 'amqp://localhost:5672',
    queue: process.env.RABBITMQ_QUEUE || 'ai_events',
    dlq: process.env.RABBITMQ_DLQ || 'ai_events_dlq',
    prefetch: parseInt(process.env.RABBITMQ_PREFETCH, 10) || 10,
    reconnectDelayMs: parseInt(process.env.RABBITMQ_RECONNECT_DELAY, 10) || 5000,
  },
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'calibrate',
    user: process.env.DB_USER || 'calibrate',
    password: process.env.DB_PASSWORD, // required — no default
  },
};
