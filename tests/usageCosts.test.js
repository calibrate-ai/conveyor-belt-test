const http = require('http');
const express = require('express');
const { mount } = require('../backend/routes/usageCosts');

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

// Mock DB pool
function createMockPool(rows = []) {
  return {
    query: jest.fn().mockResolvedValue({ rows }),
  };
}

/**
 * Create a test app with optional middleware to set req.clientId
 * (simulating the real validateClientId middleware).
 */
function createApp(dbPool, { clientId } = {}) {
  const app = express();
  app.disable('x-powered-by');

  // Simulate validateClientId middleware
  if (clientId) {
    app.use((req, _res, next) => {
      req.clientId = clientId;
      next();
    });
  }

  mount(app, dbPool);
  // 404 handler
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

function request(server, path) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: JSON.parse(data),
        });
      });
    }).on('error', reject);
  });
}

describe('GET /api/v1/usage/costs', () => {
  let server;
  let mockPool;

  afterEach((done) => {
    if (server) server.close(done);
    else done();
  });

  function startServer(pool, opts) {
    return new Promise((resolve) => {
      const app = createApp(pool, opts);
      server = app.listen(0, resolve);
    });
  }

  describe('with valid client_id from middleware', () => {
    beforeEach(async () => {
      mockPool = createMockPool([
        { period: '2026-04-01T00:00:00Z', client_id: VALID_UUID, model: 'gpt-4', cost_usd: '1.23', request_count: 100 },
      ]);
      await startServer(mockPool, { clientId: VALID_UUID });
    });

    it('returns 200 with data', async () => {
      const res = await request(server, '/api/v1/usage/costs');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.meta.client_id).toBe(VALID_UUID);
      expect(res.body.meta.granularity).toBe('hour');
    });

    it('returns data array and meta object', async () => {
      const res = await request(server, '/api/v1/usage/costs');
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta.count).toBe(1);
    });

    it('accepts day granularity', async () => {
      const res = await request(server, '/api/v1/usage/costs?granularity=day');
      expect(res.status).toBe(200);
      expect(res.body.meta.granularity).toBe('day');
    });

    it('accepts week granularity', async () => {
      const res = await request(server, '/api/v1/usage/costs?granularity=week');
      expect(res.status).toBe(200);
      expect(res.body.meta.granularity).toBe('week');
    });

    it('returns 400 for invalid granularity', async () => {
      const res = await request(server, '/api/v1/usage/costs?granularity=minute');
      expect(res.status).toBe(400);
      expect(res.body.details[0]).toMatch(/granularity/);
    });

    it('passes model filter to query', async () => {
      const res = await request(server, '/api/v1/usage/costs?model=gpt-4');
      expect(res.status).toBe(200);
      expect(res.body.meta.model).toBe('gpt-4');
      const [, values] = mockPool.query.mock.calls[0];
      expect(values).toContain('gpt-4');
    });

    it('accepts custom time range', async () => {
      const res = await request(server, '/api/v1/usage/costs?start_ts=2026-04-01T00:00:00Z&end_ts=2026-04-02T00:00:00Z');
      expect(res.status).toBe(200);
      expect(res.body.meta.start_ts).toBe('2026-04-01T00:00:00.000Z');
      expect(res.body.meta.end_ts).toBe('2026-04-02T00:00:00.000Z');
    });

    it('returns 400 for invalid timestamp', async () => {
      const res = await request(server, '/api/v1/usage/costs?start_ts=garbage');
      expect(res.status).toBe(400);
    });

    it('responds with application/json', async () => {
      const res = await request(server, '/api/v1/usage/costs');
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });

    it('calls db pool with parameterized query', async () => {
      await request(server, '/api/v1/usage/costs');
      expect(mockPool.query).toHaveBeenCalledTimes(1);
      const [sql, values] = mockPool.query.mock.calls[0];
      expect(sql).toContain('$1');
      expect(values[0]).toBe(VALID_UUID);
    });

    it('includes limit in meta', async () => {
      const res = await request(server, '/api/v1/usage/costs');
      expect(res.body.meta.limit).toBeDefined();
    });

    it('accepts custom limit', async () => {
      const res = await request(server, '/api/v1/usage/costs?limit=50');
      expect(res.status).toBe(200);
      expect(res.body.meta.limit).toBe(50);
    });
  });

  describe('without client_id (no middleware)', () => {
    it('returns 401 when req.clientId is not set', async () => {
      mockPool = createMockPool([]);
      await startServer(mockPool, {}); // no clientId middleware
      const res = await request(server, '/api/v1/usage/costs');
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/client identity/i);
    });

    it('does NOT accept client_id from query param', async () => {
      mockPool = createMockPool([]);
      await startServer(mockPool, {}); // no middleware
      const res = await request(server, `/api/v1/usage/costs?client_id=${VALID_UUID}`);
      expect(res.status).toBe(401); // still rejected — query param not used
    });
  });

  describe('empty results', () => {
    it('returns empty data array when no results', async () => {
      mockPool = createMockPool([]);
      await startServer(mockPool, { clientId: VALID_UUID });
      const res = await request(server, '/api/v1/usage/costs');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.count).toBe(0);
    });
  });

  describe('error handling', () => {
    it('returns 500 when db query fails', async () => {
      const failPool = { query: jest.fn().mockRejectedValue(new Error('connection refused')) };
      await startServer(failPool, { clientId: VALID_UUID });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request(server, '/api/v1/usage/costs');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Internal server error');
      errorSpy.mockRestore();
    });

    it('does not leak error details in 500 response', async () => {
      const failPool = { query: jest.fn().mockRejectedValue(new Error('secret DB info')) };
      await startServer(failPool, { clientId: VALID_UUID });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request(server, '/api/v1/usage/costs');
      expect(JSON.stringify(res.body)).not.toContain('secret');
      errorSpy.mockRestore();
    });
  });
});
