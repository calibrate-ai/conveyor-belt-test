/**
 * Cost capture middleware for LiteLLM proxy responses.
 *
 * Intercepts completion responses, extracts token usage,
 * calculates cost_usd, and emits an event to the Redis queue
 * for async DB write.
 *
 * Fail-open: never blocks or delays the response to the client.
 * Cost calculation happens after the response is sent.
 *
 * LIMITATION: This middleware patches res.json() to capture the response body.
 * It will NOT capture responses sent via res.send(), res.end(), or streaming.
 * If another middleware also patches res.json, the behavior depends on
 * middleware ordering. For v1 this covers all LiteLLM completion responses
 * (which are always JSON). If streaming support is needed, consider
 * res.on('finish', ...) with a separate body capture strategy.
 */

const { calculateCost } = require('../lib/pricing');

/**
 * Extract usage data from a LiteLLM/OpenAI-compatible response body.
 * Returns null if the response doesn't contain usage data.
 */
function extractUsage(body) {
  if (!body || !body.usage) return null;

  const { usage, model, id } = body;
  return {
    model: model || 'unknown',
    requestId: id || null,
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    totalTokens: usage.total_tokens || 0,
  };
}

/**
 * Build the event payload for the queue.
 */
function buildEvent(req, res, usage, costResult, latencyMs) {
  return {
    client_id: req.clientId || null,
    model: usage.model,
    provider: req.headers['x-litellm-provider'] || 'unknown',
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    cost_usd: costResult.costUsd,
    pricing_source: costResult.pricingSource,
    latency_ms: latencyMs,
    status_code: res.statusCode,
    request_id: usage.requestId,
    request_hash: req.headers['x-request-hash'] || null,
    path: req.originalUrl,
    method: req.method,
    ts: new Date().toISOString(),
  };
}

/**
 * Create the cost capture middleware.
 *
 * @param {object} emitter - Event emitter with emit(event) method
 * @returns {function} Express middleware
 */
function createCostCapture(emitter) {
  return function costCapture(req, res, next) {
    const startTime = Date.now();

    // Intercept res.json to capture the response body
    const originalJson = res.json.bind(res);
    res.json = function captureJson(body) {
      // Capture latency before sending response for accurate measurement
      const latencyMs = Date.now() - startTime;

      // Send the response immediately — never delay the client
      const result = originalJson(body);

      // Process cost capture asynchronously (fire and forget)
      setImmediate(() => {
        try {
          const usage = extractUsage(body);
          if (!usage) return; // Not a completion response, skip
          const costResult = calculateCost(usage.model, usage.promptTokens, usage.completionTokens);
          const event = buildEvent(req, res, usage, costResult, latencyMs);

          emitter.emit(event).catch(() => {
            // Already handled inside emitter (fail-open)
          });
        } catch (err) {
          // Fail open — never crash the process for cost tracking
          console.error('[costCapture] Error processing response:', err.message);
        }
      });

      return result;
    };

    next();
  };
}

module.exports = { createCostCapture, extractUsage, buildEvent };
