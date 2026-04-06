/**
 * Database configuration — reads from environment variables.
 * Never hardcode credentials.
 */
module.exports = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME || 'calibrate',
  user: process.env.DB_USER || 'calibrate',
  password: process.env.DB_PASSWORD, // required — no default
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,

  // Connection pool settings
  pool: {
    min: parseInt(process.env.DB_POOL_MIN, 10) || 2,
    max: parseInt(process.env.DB_POOL_MAX, 10) || 10,
    idleTimeoutMs: parseInt(process.env.DB_IDLE_TIMEOUT, 10) || 30000,
  },
};
