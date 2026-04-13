/**
 * TimescaleDB writer — inserts request events into the requests hypertable.
 *
 * Supports single and batch inserts. Batch mode uses a single multi-row
 * INSERT wrapped in a transaction for atomicity.
 */

const INSERT_COLUMNS = [
  'ts', 'client_id', 'model', 'provider',
  'prompt_tokens', 'completion_tokens', 'total_tokens',
  'cost_usd', 'latency_ms', 'status_code',
  'error_code', 'request_hash', 'metadata',
];

/**
 * Safely serialize metadata — avoids double-serialization if already a string.
 */
function serializeMetadata(metadata) {
  if (!metadata) return null;
  if (typeof metadata === 'string') return metadata;
  return JSON.stringify(metadata);
}

/**
 * Build a single-row parameterized INSERT values array.
 */
function buildInsertSql(event, offset = 0) {
  const values = [
    event.ts || new Date().toISOString(),
    event.client_id,
    event.model,
    event.provider || 'unknown',
    event.prompt_tokens || 0,
    event.completion_tokens || 0,
    event.total_tokens || 0,
    event.cost_usd || 0,
    event.latency_ms || 0,
    event.status_code || 200,
    event.error_code || null,
    event.request_hash || null,
    serializeMetadata(event.metadata),
  ];

  const placeholders = values.map((_, i) => `$${i + 1 + offset}`);

  return { placeholders, values };
}

/**
 * Insert a single event into the requests table.
 * @param {object} dbPool — pg Pool
 * @param {object} event — parsed event from queue
 * @returns {Promise<boolean>}
 */
async function insertOne(dbPool, event) {
  const { placeholders, values } = buildInsertSql(event);
  const sql = `INSERT INTO requests (${INSERT_COLUMNS.join(', ')}) VALUES (${placeholders.join(', ')})`;
  await dbPool.query(sql, values);
  return true;
}

/**
 * Batch insert multiple events in a single transaction with multi-row INSERT.
 * Atomic: all or nothing.
 *
 * @param {object} dbPool — pg Pool
 * @param {object[]} events — array of parsed events
 * @returns {Promise<number>} number of rows inserted
 */
async function insertBatch(dbPool, events) {
  if (events.length === 0) return 0;

  if (events.length === 1) {
    await insertOne(dbPool, events[0]);
    return 1;
  }

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    const allValues = [];
    const rowPlaceholders = [];

    events.forEach((event, rowIdx) => {
      const offset = rowIdx * INSERT_COLUMNS.length;
      const { placeholders, values } = buildInsertSql(event, offset);
      rowPlaceholders.push(`(${placeholders.join(', ')})`);
      allValues.push(...values);
    });

    const sql = `INSERT INTO requests (${INSERT_COLUMNS.join(', ')}) VALUES ${rowPlaceholders.join(', ')}`;
    const result = await client.query(sql, allValues);

    await client.query('COMMIT');
    return result.rowCount;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { insertOne, insertBatch, buildInsertSql, INSERT_COLUMNS, serializeMetadata };
