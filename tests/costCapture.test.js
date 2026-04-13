const http = require('http');
const express = require('express');
const { createCostCapture, extractUsage, buildEvent } = require('../backend/middleware/costCapture');

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

  describe('createCostCapture (integration)', () => {
    let server;

    afterEach((done) => {
      if (server) server.close(done);
      else done();
    });

    function request(srv, path) {
      const { port } = srv.address();
      return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${path}`, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          });
        }).on('error', reject);
      });
    }

    function wait(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    it('calls emitter.emit when response contains usage data', async () => {
      const mockEmitter = { emit: jest.fn().mockResolvedValue(true) };
      const app = express();
      app.use(createCostCapture(mockEmitter));
      app.get('/test', (_req, res) => {
        res.json({
          id: 'chatcmpl-test',
          model: 'gpt-4',
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        });
      });

      await new Promise((resolve) => { server = app.listen(0, resolve); });
      const res = await request(server, '/test');
      expect(res.status).toBe(200);

      // Wait for setImmediate to fire
      await wait(50);

      expect(mockEmitter.emit).toHaveBeenCalledTimes(1);
      const event = mockEmitter.emit.mock.calls[0][0];
      expect(event.model).toBe('gpt-4');
      expect(event.cost_usd).toBeGreaterThan(0);
      expect(event.prompt_tokens).toBe(100);
      expect(event.completion_tokens).toBe(50);
    });

    it('does NOT call emitter.emit for non-completion responses', async () => {
      const mockEmitter = { emit: jest.fn().mockResolvedValue(true) };
      const app = express();
      app.use(createCostCapture(mockEmitter));
      app.get('/health', (_req, res) => {
        res.json({ status: 'ok' });
      });

      await new Promise((resolve) => { server = app.listen(0, resolve); });
      await request(server, '/health');
      await wait(50);

      expect(mockEmitter.emit).not.toHaveBeenCalled();
    });

    it('captures latency before sending response (not after event loop delay)', async () => {
      const mockEmitter = { emit: jest.fn().mockResolvedValue(true) };
      const app = express();
      app.use(createCostCapture(mockEmitter));
      app.get('/test', (_req, res) => {
        // Simulate some processing time
        const start = Date.now();
        while (Date.now() - start < 20) { /* busy wait ~20ms */ }
        res.json({
          model: 'gpt-4',
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        });
      });

      await new Promise((resolve) => { server = app.listen(0, resolve); });
      await request(server, '/test');
      await wait(50);

      expect(mockEmitter.emit).toHaveBeenCalledTimes(1);
      const event = mockEmitter.emit.mock.calls[0][0];
      // Latency should reflect request processing time (~20ms+), not event loop overhead
      expect(event.latency_ms).toBeGreaterThanOrEqual(15);
      // Should not include the 50ms wait time from setImmediate delay
      expect(event.latency_ms).toBeLessThan(100);
    });

    it('still returns response when emitter fails (fail-open)', async () => {
      const mockEmitter = { emit: jest.fn().mockRejectedValue(new Error('redis down')) };
      const app = express();
      app.use(createCostCapture(mockEmitter));
      app.get('/test', (_req, res) => {
        res.json({
          model: 'gpt-4',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      });

      await new Promise((resolve) => { server = app.listen(0, resolve); });
      const res = await request(server, '/test');
      expect(res.status).toBe(200);
      expect(res.body.model).toBe('gpt-4');
    });
  });
});
