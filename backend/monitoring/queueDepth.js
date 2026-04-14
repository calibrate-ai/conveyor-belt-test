/**
 * Queue depth monitoring — alerts when ai_events queue depth exceeds thresholds.
 *
 * Checks Redis list lengths for the main queue and DLQ,
 * emits structured alerts when thresholds are breached.
 *
 * Designed to be called periodically (cron, setInterval, or external scheduler).
 */

const DEFAULT_CONFIG = {
  queues: {
    main: process.env.REDIS_QUEUE_NAME || 'ai_events',
    dlq: process.env.REDIS_DLQ_NAME || 'ai_events_dlq',
    archive: process.env.REDIS_ARCHIVE_NAME || 'ai_events_dead',
  },
  thresholds: {
    // Main queue: events waiting to be consumed
    mainWarning: parseInt(process.env.QUEUE_WARN_THRESHOLD, 10) || 100,
    mainCritical: parseInt(process.env.QUEUE_CRIT_THRESHOLD, 10) || 1000,
    // DLQ: any events here means something is wrong
    dlqWarning: parseInt(process.env.DLQ_WARN_THRESHOLD, 10) || 1,
    dlqCritical: parseInt(process.env.DLQ_CRIT_THRESHOLD, 10) || 10,
  },
};

/**
 * Determine severity level based on depth and thresholds.
 * Returns 'ok' | 'warning' | 'critical'.
 */
function getSeverity(depth, warningThreshold, criticalThreshold) {
  if (depth >= criticalThreshold) return 'critical';
  if (depth >= warningThreshold) return 'warning';
  return 'ok';
}

/**
 * Emit a structured queue depth alert.
 */
function emitQueueAlert(queueName, depth, severity, thresholds) {
  const alert = {
    level: severity === 'critical' ? 'alert' : 'warn',
    code: 'QUEUE-DEPTH',
    queue: queueName,
    depth,
    severity,
    warning_threshold: thresholds.warning,
    critical_threshold: thresholds.critical,
    timestamp: new Date().toISOString(),
  };

  if (severity === 'critical') {
    console.error(JSON.stringify(alert));
  } else {
    console.warn(JSON.stringify(alert));
  }

  return alert;
}

/**
 * Check all queue depths and return a status report.
 *
 * @param {object} redisClient — ioredis client with llen()
 * @param {object} config — optional override of DEFAULT_CONFIG
 * @returns {Promise<object>} status report with depths and alerts
 */
async function checkQueueDepths(redisClient, config = DEFAULT_CONFIG) {
  const { queues, thresholds } = config;
  const alerts = [];

  // Check all queues in parallel
  const [mainDepth, dlqDepth, archiveDepth] = await Promise.all([
    redisClient.llen(queues.main),
    redisClient.llen(queues.dlq),
    redisClient.llen(queues.archive),
  ]);

  // Main queue check
  const mainSeverity = getSeverity(mainDepth, thresholds.mainWarning, thresholds.mainCritical);
  if (mainSeverity !== 'ok') {
    alerts.push(emitQueueAlert(queues.main, mainDepth, mainSeverity, {
      warning: thresholds.mainWarning,
      critical: thresholds.mainCritical,
    }));
  }

  // DLQ check — any events here is notable
  const dlqSeverity = getSeverity(dlqDepth, thresholds.dlqWarning, thresholds.dlqCritical);
  if (dlqSeverity !== 'ok') {
    alerts.push(emitQueueAlert(queues.dlq, dlqDepth, dlqSeverity, {
      warning: thresholds.dlqWarning,
      critical: thresholds.dlqCritical,
    }));
  }

  return {
    status: alerts.some((a) => a.severity === 'critical') ? 'critical'
      : alerts.some((a) => a.severity === 'warning') ? 'warning'
      : 'ok',
    depths: {
      [queues.main]: mainDepth,
      [queues.dlq]: dlqDepth,
      [queues.archive]: archiveDepth,
    },
    alerts,
    checked_at: new Date().toISOString(),
  };
}

module.exports = { checkQueueDepths, getSeverity, emitQueueAlert, DEFAULT_CONFIG };
