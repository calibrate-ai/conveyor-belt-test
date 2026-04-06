const { calculateCost, MODEL_PRICING, DEFAULT_PRICING } = require('../backend/lib/pricing');

describe('pricing', () => {
  describe('calculateCost', () => {
    it('calculates cost for known model (gpt-4)', () => {
      const result = calculateCost('gpt-4', 1000, 500);
      const expected = (1000 * 0.00003) + (500 * 0.00006);
      expect(result.costUsd).toBeCloseTo(expected, 6);
      expect(result.pricingSource).toBe('exact');
    });

    it('calculates cost for gpt-4o-mini', () => {
      const result = calculateCost('gpt-4o-mini', 10000, 5000);
      const expected = (10000 * 0.00000015) + (5000 * 0.0000006);
      expect(result.costUsd).toBeCloseTo(expected, 6);
      expect(result.pricingSource).toBe('exact');
    });

    it('calculates cost for claude-3-sonnet', () => {
      const result = calculateCost('claude-3-sonnet', 2000, 1000);
      const expected = (2000 * 0.000003) + (1000 * 0.000015);
      expect(result.costUsd).toBeCloseTo(expected, 6);
    });

    it('uses prefix matching for versioned models', () => {
      const result = calculateCost('gpt-4-0613', 1000, 500);
      expect(result.pricingSource).toBe('prefix:gpt-4');
      const expected = (1000 * 0.00003) + (500 * 0.00006);
      expect(result.costUsd).toBeCloseTo(expected, 6);
    });

    it('falls back to default pricing for unknown model', () => {
      const result = calculateCost('some-new-model', 1000, 500);
      expect(result.pricingSource).toBe('default');
      const expected = (1000 * DEFAULT_PRICING.prompt) + (500 * DEFAULT_PRICING.completion);
      expect(result.costUsd).toBeCloseTo(expected, 6);
    });

    it('returns 0 for zero tokens', () => {
      const result = calculateCost('gpt-4', 0, 0);
      expect(result.costUsd).toBe(0);
    });

    it('handles prompt-only (no completion tokens)', () => {
      const result = calculateCost('gpt-4', 1000, 0);
      expect(result.costUsd).toBeCloseTo(1000 * 0.00003, 6);
    });

    it('handles completion-only (no prompt tokens)', () => {
      const result = calculateCost('gpt-4', 0, 1000);
      expect(result.costUsd).toBeCloseTo(1000 * 0.00006, 6);
    });

    it('rounds to 6 decimal places', () => {
      const result = calculateCost('gpt-4', 1, 1);
      const parts = result.costUsd.toString().split('.');
      if (parts[1]) {
        expect(parts[1].length).toBeLessThanOrEqual(6);
      }
    });

    it('all models in pricing table have both prompt and completion prices', () => {
      Object.entries(MODEL_PRICING).forEach(([model, pricing]) => {
        expect(pricing).toHaveProperty('prompt');
        expect(pricing).toHaveProperty('completion');
        expect(typeof pricing.prompt).toBe('number');
        expect(typeof pricing.completion).toBe('number');
        expect(pricing.prompt).toBeGreaterThan(0);
        expect(pricing.completion).toBeGreaterThan(0);
      });
    });
  });
});
