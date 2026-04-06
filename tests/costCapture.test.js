const { extractUsage, buildEvent } = require('../backend/middleware/costCapture');

describe('costCapture middleware', () => {
  describe('extractUsage', () => {
    it('extracts usage from OpenAI-compatible response', () => {
      const body = {
        id: 'chatcmpl-123',
        model: 'gpt-4',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        },
      };
      const result = extractUsage(body);
      expect(result).toEqual({
        model: 'gpt-4',
        requestId: 'chatcmpl-123',
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      });
    });

    it('returns null for non-completion responses', () => {
      expect(extractUsage({ status: 'ok' })).toBeNull();
      expect(extractUsage(null)).toBeNull();
      expect(extractUsage(undefined)).toBeNull();
    });

    it('defaults model to unknown when missing', () => {
      const body = { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      const result = extractUsage(body);
      expect(result.model).toBe('unknown');
    });

    it('defaults token counts to 0 when missing', () => {
      const body = { model: 'gpt-4', usage: {} };
      const result = extractUsage(body);
      expect(result.promptTokens).toBe(0);
      expect(result.completionTokens).toBe(0);
      expect(result.totalTokens).toBe(0);
    });

    it('handles null requestId', () => {
      const body = { model: 'gpt-4', usage: { prompt_tokens: 10 } };
      const result = extractUsage(body);
      expect(result.requestId).toBeNull();
    });
  });

  describe('buildEvent', () => {
    const mockReq = {
      clientId: '550e8400-e29b-41d4-a716-446655440000',
      headers: {
        'x-litellm-provider': 'openai',
        'x-request-hash': 'abc123',
      },
      originalUrl: '/v1/chat/completions',
      method: 'POST',
    };

    const mockRes = { statusCode: 200 };

    const usage = {
      model: 'gpt-4',
      requestId: 'chatcmpl-123',
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    };

    const costResult = { costUsd: 0.006, pricingSource: 'exact' };

    it('builds complete event payload', () => {
      const event = buildEvent(mockReq, mockRes, usage, costResult, 250);
      expect(event).toEqual(expect.objectContaining({
        client_id: '550e8400-e29b-41d4-a716-446655440000',
        model: 'gpt-4',
        provider: 'openai',
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        cost_usd: 0.006,
        pricing_source: 'exact',
        latency_ms: 250,
        status_code: 200,
        request_id: 'chatcmpl-123',
        request_hash: 'abc123',
        path: '/v1/chat/completions',
        method: 'POST',
      }));
      expect(event.ts).toBeDefined();
    });

    it('handles missing provider header', () => {
      const req = { ...mockReq, headers: {} };
      const event = buildEvent(req, mockRes, usage, costResult, 100);
      expect(event.provider).toBe('unknown');
    });

    it('handles missing clientId', () => {
      const req = { ...mockReq, clientId: undefined };
      const event = buildEvent(req, mockRes, usage, costResult, 100);
      expect(event.client_id).toBeNull();
    });

    it('handles missing request_hash', () => {
      const req = { ...mockReq, headers: { 'x-litellm-provider': 'openai' } };
      const event = buildEvent(req, mockRes, usage, costResult, 100);
      expect(event.request_hash).toBeNull();
    });

    it('includes ISO timestamp', () => {
      const event = buildEvent(mockReq, mockRes, usage, costResult, 100);
      const ts = new Date(event.ts);
      expect(ts.toISOString()).toBe(event.ts);
    });
  });
});
