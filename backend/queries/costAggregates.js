/**
 * Cost aggregate query builder for /api/v1/usage/costs
 *
 * Builds parameterized SQL queries against the cost_rollup_hourly
 * continuous aggregate.
 *
 * All queries are scoped by client_id (tenant isolation).
 * All dynamic values — including time_bucket interval — are parameterized
 * for defense in depth.
 */

const VALID_GRANULARITIES = ['hour', 'day', 'week'];

const GRANULARITY_INTERVALS = {
  hour: '1 hour',
  day: '1 day',
  week: '1 week',
};

// Default and max result limits to prevent accidental full-table dumps
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10000;

/**
 * Validate and parse query parameters for cost aggregates.
 * Returns { valid: true, params } or { valid: false, error }.
 */
function validateParams(query) {
  const errors = [];

  // client_id is required (comes from validated middleware in production)
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

  // Limit (optional, for pagination)
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    limit = parseInt(query.limit, 10);
    if (isNaN(limit) || limit < 1) {
      errors.push('limit must be a positive integer');
      limit = DEFAULT_LIMIT;
    } else if (limit > MAX_LIMIT) {
      limit = MAX_LIMIT;
    }
  }

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
      limit,
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
  const { clientId, granularity, startTs, endTs, model, limit } = params;
  const interval = GRANULARITY_INTERVALS[granularity];

  // Build values array: $1=client_id, $2=start, $3=end, then optional model, then limit
  // For day/week: interval is added as a parameter too
  const values = [clientId, startTs.toISOString(), endTs.toISOString()];
  let nextIdx = 4;

  let modelFilter = '';
  if (model) {
    modelFilter = `AND model = $${nextIdx}`;
    values.push(model);
    nextIdx++;
  }

  let sql;

  if (granularity === 'hour') {
    // Direct read from hourly continuous aggregate — no re-bucketing needed
    const limitIdx = nextIdx;
    values.push(limit || DEFAULT_LIMIT);

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
      FROM cost_rollup_hourly
      WHERE client_id = $1
        AND bucket >= $2
        AND bucket < $3
        ${modelFilter}
      ORDER BY bucket DESC, model ASC
      LIMIT $${limitIdx}
    `;
  } else {
    // Re-bucket for day/week — interval parameterized for defense in depth
    const intervalIdx = nextIdx;
    values.push(interval);
    nextIdx++;

    const limitIdx = nextIdx;
    values.push(limit || DEFAULT_LIMIT);

    sql = `
      SELECT
        time_bucket($${intervalIdx}::interval, bucket) AS period,
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
      FROM cost_rollup_hourly
      WHERE client_id = $1
        AND bucket >= $2
        AND bucket < $3
        ${modelFilter}
      GROUP BY period, client_id, model, provider
      ORDER BY period DESC, model ASC
      LIMIT $${limitIdx}
    `;
  }

  return { sql: sql.trim(), values };
}

module.exports = {
  validateParams,
  buildQuery,
  VALID_GRANULARITIES,
  GRANULARITY_INTERVALS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
