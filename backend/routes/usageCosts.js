/**
 * GET /api/v1/usage/costs
 *
 * Returns cost aggregates scoped by client_id.
 *
 * Query params:
 *   model       (optional) — filter by model name
 *   start_ts    (optional) — ISO 8601, defaults to 24h ago
 *   end_ts      (optional) — ISO 8601, defaults to now
 *   granularity (optional) — hour|day|week, defaults to hour
 *   limit       (optional) — max rows, defaults to 1000, max 10000
 *
 * client_id comes from the validated middleware (req.clientId).
 * It is NOT accepted as a query parameter — tenant isolation is enforced
 * by the middleware, not by the caller.
 *
 * NOTE: This route is not yet mounted in server.js. It will be wired up
 * once the DB pool is configured (requires pg + TimescaleDB connection).
 * See backend/db/config.js for connection setup.
 */

const { validateParams, buildQuery } = require('../queries/costAggregates');

/**
 * Execute the cost query against the database.
 * Accepts a db pool/client for dependency injection (testability).
 */
function createHandler(dbPool) {
  return async (req, res) => {
    // client_id MUST come from validated middleware — never from query params.
    // This ensures tenant isolation cannot be bypassed by the caller.
    const clientId = req.clientId;

    if (!clientId) {
      return res.status(401).json({
        error: 'Missing client identity — x-client-id header required',
      });
    }

    const validation = validateParams({
      ...req.query,
      client_id: clientId,
    });

    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid query parameters',
        details: validation.errors,
      });
    }

    const { sql, values } = buildQuery(validation.params);

    try {
      const result = await dbPool.query(sql, values);

      return res.json({
        data: result.rows,
        meta: {
          client_id: validation.params.clientId,
          granularity: validation.params.granularity,
          start_ts: validation.params.startTs.toISOString(),
          end_ts: validation.params.endTs.toISOString(),
          model: validation.params.model,
          limit: validation.params.limit,
          count: result.rows.length,
        },
      });
    } catch (err) {
      console.error('Cost query failed:', err.message);
      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  };
}

/**
 * Mount the usage costs route.
 * @param {object} app — Express app instance
 * @param {object} dbPool — pg Pool instance for database queries
 */
function mount(app, dbPool) {
  app.get('/api/v1/usage/costs', createHandler(dbPool));
}

module.exports = { mount, createHandler };
