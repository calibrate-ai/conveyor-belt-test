/**
 * GET /api/v1/usage/costs
 *
 * Returns cost aggregates scoped by client_id.
 *
 * Query params:
 *   client_id   (required) — UUID v4, tenant identifier
 *   model       (optional) — filter by model name
 *   start_ts    (optional) — ISO 8601, defaults to 24h ago
 *   end_ts      (optional) — ISO 8601, defaults to now
 *   granularity (optional) — hour|day|week, defaults to hour
 *
 * In production, client_id will come from the validated middleware
 * (req.clientId). For now, it's accepted as a query parameter.
 */

const express = require('express');
const { validateParams, buildQuery } = require('../queries/costAggregates');

const router = express.Router();

/**
 * Execute the cost query against the database.
 * Accepts a db pool/client for dependency injection (testability).
 */
function createHandler(dbPool) {
  return async (req, res) => {
    // In production, prefer req.clientId from middleware over query param
    const clientId = req.clientId || req.query.client_id;

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
 * @param {object} dbPool — pg Pool instance for database queries
 */
function mount(app, dbPool) {
  app.get('/api/v1/usage/costs', createHandler(dbPool));
}

module.exports = { mount, createHandler, router };
