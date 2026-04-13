/**
 * Model pricing lookup — maps model names to per-token costs.
 *
 * Prices in USD per token. Source: provider pricing pages as of 2026-04.
 * Update these when pricing changes or new models are added.
 *
 * Format: { prompt: cost_per_token, completion: cost_per_token }
 */

const MODEL_PRICING = {
  // OpenAI
  'gpt-4': { prompt: 0.00003, completion: 0.00006 },
  'gpt-4-turbo': { prompt: 0.00001, completion: 0.00003 },
  'gpt-4o': { prompt: 0.000005, completion: 0.000015 },
  'gpt-4o-mini': { prompt: 0.00000015, completion: 0.0000006 },
  'gpt-3.5-turbo': { prompt: 0.0000005, completion: 0.0000015 },

  // Anthropic
  'claude-3-opus': { prompt: 0.000015, completion: 0.000075 },
  'claude-3-sonnet': { prompt: 0.000003, completion: 0.000015 },
  'claude-3-haiku': { prompt: 0.00000025, completion: 0.00000125 },
  'claude-3.5-sonnet': { prompt: 0.000003, completion: 0.000015 },

  // Google
  'gemini-1.5-pro': { prompt: 0.0000035, completion: 0.0000105 },
  'gemini-1.5-flash': { prompt: 0.00000035, completion: 0.00000105 },
};

// Default fallback pricing when model is unknown
const DEFAULT_PRICING = { prompt: 0.00001, completion: 0.00003 };

// Pre-sort keys by length descending for correct prefix matching.
// Ensures "gpt-4o-mini" matches before "gpt-4o" or "gpt-4".
const SORTED_MODEL_KEYS = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);

/**
 * Calculate cost in USD for a given model + token counts.
 * Falls back to default pricing for unknown models (with a warning log).
 *
 * @param {string} model - Model name
 * @param {number} promptTokens - Number of prompt tokens
 * @param {number} completionTokens - Number of completion tokens
 * @returns {{ costUsd: number, pricingSource: string }}
 */
function calculateCost(model, promptTokens, completionTokens) {
  // Try exact match first
  let pricing = MODEL_PRICING[model];
  let source = 'exact';

  if (!pricing) {
    // Prefix match — sorted longest-first for specificity
    const prefix = SORTED_MODEL_KEYS.find((key) => model.startsWith(key));
    if (prefix) {
      pricing = MODEL_PRICING[prefix];
      source = `prefix:${prefix}`;
    }
  }

  if (!pricing) {
    pricing = DEFAULT_PRICING;
    source = 'default';
    // Warn operators so they know the pricing table needs updating
    console.warn(`[pricing] Unknown model "${model}" — using default pricing. Add to MODEL_PRICING.`);
  }

  const costUsd = (promptTokens * pricing.prompt) + (completionTokens * pricing.completion);

  return {
    costUsd: Math.round(costUsd * 1e6) / 1e6, // 6 decimal places
    pricingSource: source,
  };
}

module.exports = { calculateCost, MODEL_PRICING, DEFAULT_PRICING, SORTED_MODEL_KEYS };
