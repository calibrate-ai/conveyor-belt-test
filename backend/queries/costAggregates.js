/**
 * Cost aggregate query builder for /api/v1/usage/costs
 *
 * Builds parameterized SQL queries against the cost_rollup_hourly
 * continuous aggregate (or falls back to the requests hypertable
 * for sub-hour granularity).
 *
 * All queries are scoped by client_id (tenant isolation).
 */

const VALID_GRANULARITIES = ['hour', 'day', 'week'];

const GRANULARITY_INTERVALS = {
  hour: '1 hour',
  day: '1 day',
  week: '1 week',
};

/**
 * Validate and parse query parameters for cost aggregates.
 * Returns { valid: true, params } or { valid: false, error }.
 */
function validateParams(query) {
  const errors = [];

  // client_id is required (comes from middleware in production)
  if (!query.client_id) {
    errors.push('client_id is required');
  }

  // Validate UUID format if provided
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (query.client_id && !UUID_RE.test(query.client_id)) {
    errors.push('client_id must be a valid UUID v4');
  }

  // Granularity
  const granularity = query.granularity || 'hour';
  if (!VALID_GRANULARITIES.includes(granularity)) {
    errors.push(`granularity must be one of: ${VALID_GRANULARITIES.join(', ')}`);
  }

  // Time range
  const now = new Date();
  const defaultStart = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24h ago

  let startTs, endTs;
  if (query.start_ts) {
    startTs = new Date(query.start_ts);
    if (isNaN(startTs.getTime())) errors.push('start_ts must be a valid ISO 8601 timestamp');
  } else {
    startTs = defaultStart;
  }

  if (query.end_ts) {
    endTs = new Date(query.end_ts);
    if (isNaN(endTs.getTime())) errors.push('end_ts must be a valid ISO 8601 timestamp');
  } else {
    endTs = now;
  }

  if (startTs && endTs && startTs >= endTs) {
    errors.push('start_ts must be before end_ts');
  }

  // Model filter (optional)
  const model = query.model || null;

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    params: {
      clientId: query.client_id.toLowerCase(),
      granularity,
      startTs,
      endTs,
      model,
    },
  };
}

/**
 * Build a parameterized SQL query for cost aggregates.
 * Uses the continuous aggregate for hour+ granularity.
 *
 * Returns { sql, values } for use with pg client.query().
 */
function buildQuery(params) {
  const { clientId, granularity, startTs, endTs, model } = params;
  const interval = GRANULARITY_INTERVALS[granularity];

  // For hour granularity, read directly from the continuous aggregate
  // For day/week, re-bucket the hourly aggregate
  const source = 'cost_rollup_hourly';

  const values = [clientId, startTs.toISOString(), endTs.toISOString()];
  let paramIdx = 4;

  let modelFilter = '';
  if (model) {
    modelFilter = `AND model = $${paramIdx}`;
    values.push(model);
    paramIdx++;
  }

  let sql;

  if (granularity === 'hour') {
    // Direct read from hourly aggregate
    sql = `
      SELECT
        bucket AS period,
        client_id,
        model,
        provider,
        request_count,
        total_cost_usd AS cost_usd,
        total_prompt_tokens AS prompt_tokens,
        total_completion_tokens AS completion_tokens,
        total_tokens,
        avg_latency_ms,
        error_count
      FROM ${source}
      WHERE client_id = $1
        AND bucket >= $2
        AND bucket < $3
        ${modelFilter}
      ORDER BY bucket DESC, model ASC
    `;
  } else {
    // Re-bucket for day/week
    sql = `
      SELECT
        time_bucket('${interval}', bucket) AS period,
        client_id,
        model,
        provider,
        SUM(request_count)::bigint AS request_count,
        SUM(total_cost_usd) AS cost_usd,
        SUM(total_prompt_tokens)::bigint AS prompt_tokens,
        SUM(total_completion_tokens)::bigint AS completion_tokens,
        SUM(total_tokens)::bigint AS total_tokens,
        AVG(avg_latency_ms) AS avg_latency_ms,
        SUM(error_count)::bigint AS error_count
      FROM ${source}
      WHERE client_id = $1
        AND bucket >= $2
        AND bucket < $3
        ${modelFilter}
      GROUP BY period, client_id, model, provider
      ORDER BY period DESC, model ASC
    `;
  }

  return { sql: sql.trim(), values };
}

module.exports = {
  validateParams,
  buildQuery,
  VALID_GRANULARITIES,
  GRANULARITY_INTERVALS,
};
