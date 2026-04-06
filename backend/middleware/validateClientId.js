/**
 * client_id validation middleware (F-002)
 *
 * Validates the x-client-id header on all non-health routes.
 * - Missing header  → 401 + alert
 * - Invalid format  → 400 + alert
 * - Valid           → attaches req.clientId (normalized to lowercase) and continues
 *
 * Valid client_id: UUID v4 format (hex + hyphens, case-insensitive).
 * Stored lowercase on req.clientId for consistent downstream lookups.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Max length for client_id header before we truncate in logs
const MAX_CLIENT_ID_LOG_LEN = 128;

// Paths exempt from client_id validation (exact match + direct sub-paths only)
const EXEMPT_PATHS = ['/health'];

// In-memory alert counter (swap for real alerting integration later)
// TODO: Add ceiling or periodic reset to prevent unbounded growth under sustained attack.
const alertCounters = { missing: 0, invalid: 0 };

function resetAlertCounters() {
  alertCounters.missing = 0;
  alertCounters.invalid = 0;
}

function getAlertCounters() {
  return { ...alertCounters };
}

/**
 * Sanitize user input for safe log inclusion:
 * - Strip newlines/carriage returns to prevent log injection
 * - Truncate to max length
 */
function sanitizeForLog(str, max = MAX_CLIENT_ID_LOG_LEN) {
  if (!str) return str;
  const clean = str.replace(/[\n\r]/g, '');
  if (clean.length > max) {
    return clean.slice(0, max) + `...[truncated, ${str.length} chars]`;
  }
  return clean;
}

/**
 * Emits a structured alert log.
 * Replace console.error with your alerting transport (e.g. PagerDuty, Slack webhook).
 *
 * NOTE: req.ip returns the socket address by default. If behind a reverse proxy
 * (HAProxy, nginx, ALB), configure `app.set('trust proxy', ...)` so req.ip
 * reflects the real client IP via X-Forwarded-For.
 *
 * TODO: Add sliding-window rate limiting to suppress alert floods
 * (e.g. max 100 alerts per 60s per type, then suppress with a summary).
 */
function emitAlert(type, detail, req) {
  const alert = {
    level: 'alert',
    code: 'F-002',
    type,
    detail: sanitizeForLog(detail),
    ip: req.ip,
    path: req.originalUrl,
    method: req.method,
    timestamp: new Date().toISOString(),
  };
  console.error(JSON.stringify(alert));
  return alert;
}

/**
 * Check if a request path is exempt from client_id validation.
 * Uses resolved path to prevent traversal bypasses (e.g. /health/../admin).
 */
function isExemptPath(reqPath) {
  // Resolve path traversals: normalize ../ and ./ segments
  const { posix } = require('path');
  const resolved = posix.normalize(reqPath);
  return EXEMPT_PATHS.some((p) => resolved === p || resolved.startsWith(p + '/'));
}

function validateClientId(req, res, next) {
  // Skip exempt paths
  if (isExemptPath(req.path)) {
    return next();
  }

  const clientId = req.headers['x-client-id'];

  // Empty string is falsy — treated as missing per design.
  // Rationale: an empty x-client-id header provides no identity, same as absent.
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
    const safeId = clientId.slice(0, MAX_CLIENT_ID_LOG_LEN).replace(/[\n\r]/g, '');
    const alert = emitAlert('invalid_client_id', `Invalid client_id format: ${safeId}`, req);
    return res.status(400).json({
      error: 'Invalid x-client-id format — expected UUID v4',
      code: 'F-002',
      alert_type: alert.type,
    });
  }

  // Normalize to lowercase for consistent downstream lookups
  req.clientId = clientId.toLowerCase();
  next();
}

module.exports = { validateClientId, getAlertCounters, resetAlertCounters, sanitizeForLog, isExemptPath, UUID_RE, MAX_CLIENT_ID_LOG_LEN, EXEMPT_PATHS };
