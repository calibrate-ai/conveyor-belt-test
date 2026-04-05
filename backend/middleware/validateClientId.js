/**
 * client_id validation middleware (F-002)
 *
 * Validates the x-client-id header on all non-health routes.
 * - Missing header  → 401 + alert
 * - Invalid format  → 400 + alert
 * - Valid           → attaches req.clientId and continues
 *
 * Valid client_id: UUID v4 format (lowercase hex + hyphens).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Max length for client_id header before we truncate in logs
const MAX_CLIENT_ID_LOG_LEN = 128;

// Paths exempt from client_id validation
const EXEMPT_PATHS = ['/health'];

// In-memory alert counter (swap for real alerting integration later)
const alertCounters = { missing: 0, invalid: 0 };

function resetAlertCounters() {
  alertCounters.missing = 0;
  alertCounters.invalid = 0;
}

function getAlertCounters() {
  return { ...alertCounters };
}

/**
 * Emits a structured alert log.
 * Replace console.error with your alerting transport (e.g. PagerDuty, Slack webhook).
 */
function truncate(str, max = MAX_CLIENT_ID_LOG_LEN) {
  if (str && str.length > max) {
    return str.slice(0, max) + `...[truncated, ${str.length} chars]`;
  }
  return str;
}

function emitAlert(type, detail, req) {
  const alert = {
    level: 'alert',
    code: 'F-002',
    type,
    detail: truncate(detail),
    ip: req.ip,
    path: req.originalUrl,
    method: req.method,
    timestamp: new Date().toISOString(),
  };
  console.error(JSON.stringify(alert));
  return alert;
}

function validateClientId(req, res, next) {
  // Skip exempt paths (health, health sub-paths)
  if (EXEMPT_PATHS.some((p) => req.path === p || req.path.startsWith(p + '/'))) {
    return next();
  }

  const clientId = req.headers['x-client-id'];

  if (!clientId) {
    alertCounters.missing++;
    const alert = emitAlert('missing_client_id', 'Request has no x-client-id header', req);
    return res.status(401).json({
      error: 'Missing x-client-id header',
      code: 'F-002',
      alert_type: alert.type,
    });
  }

  if (!UUID_RE.test(clientId)) {
    alertCounters.invalid++;
    const alert = emitAlert('invalid_client_id', `Invalid client_id format: ${clientId}`, req);
    return res.status(400).json({
      error: 'Invalid x-client-id format — expected UUID v4',
      code: 'F-002',
      alert_type: alert.type,
    });
  }

  req.clientId = clientId;
  next();
}

module.exports = { validateClientId, getAlertCounters, resetAlertCounters, UUID_RE, MAX_CLIENT_ID_LOG_LEN, EXEMPT_PATHS };
