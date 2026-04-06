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

function createApp(dbPool) {
  const app = express();
  app.disable('x-powered-by');
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

  beforeEach((done) => {
    mockPool = createMockPool([
      { period: '2026-04-01T00:00:00Z', client_id: VALID_UUID, model: 'gpt-4', cost_usd: '1.23', request_count: 100 },
    ]);
    const app = createApp(mockPool);
    server = app.listen(0, done);
  });

  afterEach((done) => {
    server.close(done);
  });

  it('returns 200 with valid client_id', async () => {
    const res = await request(server, `/api/v1/usage/costs?client_id=${VALID_UUID}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.client_id).toBe(VALID_UUID);
    expect(res.body.meta.granularity).toBe('hour');
  });

  it('returns data array and meta object', async () => {
    const res = await request(server, `/api/v1/usage/costs?client_id=${VALID_UUID}`);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta.count).toBe(1);
  });

  it('returns 400 when client_id is missing', async () => {
    const res = await request(server, '/api/v1/usage/costs');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid/);
    expect(res.body.details).toEqual(expect.arrayContaining([
      expect.stringContaining('client_id'),
    ]));
  });

  it('returns 400 for invalid client_id', async () => {
    const res = await request(server, '/api/v1/usage/costs?client_id=bad');
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(expect.arrayContaining([
      expect.stringContaining('UUID'),
    ]));
  });

  it('returns 400 for invalid granularity', async () => {
    const res = await request(server, `/api/v1/usage/costs?client_id=${VALID_UUID}&granularity=minute`);
    expect(res.status).toBe(400);
    expect(res.body.details[0]).toMatch(/granularity/);
  });

  it('accepts day granularity', async () => {
    const res = await request(server, `/api/v1/usage/costs?client_id=${VALID_UUID}&granularity=day`);
    expect(res.status).toBe(200);
    expect(res.body.meta.granularity).toBe('day');
  });

  it('accepts week granularity', async () => {
    const res = await request(server, `/api/v1/usage/costs?client_id=${VALID_UUID}&granularity=week`);
    expect(res.status).toBe(200);
    expect(res.body.meta.granularity).toBe('week');
  });

  it('passes model filter to query', async () => {
    const res = await request(server, `/api/v1/usage/costs?client_id=${VALID_UUID}&model=gpt-4`);
    expect(res.status).toBe(200);
    expect(res.body.meta.model).toBe('gpt-4');
    // Verify mock was called with model in values
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const [, values] = mockPool.query.mock.calls[0];
    expect(values).toContain('gpt-4');
  });

  it('accepts custom time range', async () => {
    const res = await request(server, `/api/v1/usage/costs?client_id=${VALID_UUID}&start_ts=2026-04-01T00:00:00Z&end_ts=2026-04-02T00:00:00Z`);
    expect(res.status).toBe(200);
    expect(res.body.meta.start_ts).toBe('2026-04-01T00:00:00.000Z');
    expect(res.body.meta.end_ts).toBe('2026-04-02T00:00:00.000Z');
  });

  it('returns 400 for invalid timestamp', async () => {
    const res = await request(server, `/api/v1/usage/costs?client_id=${VALID_UUID}&start_ts=garbage`);
    expect(res.status).toBe(400);
  });

  it('responds with application/json', async () => {
    const res = await request(server, `/api/v1/usage/costs?client_id=${VALID_UUID}`);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('calls db pool with parameterized query', async () => {
    await request(server, `/api/v1/usage/costs?client_id=${VALID_UUID}`);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const [sql, values] = mockPool.query.mock.calls[0];
    expect(sql).toContain('$1');
    expect(values[0]).toBe(VALID_UUID);
  });

  it('returns empty data array when no results', async () => {
    server.close();
    mockPool = createMockPool([]);
    const app = createApp(mockPool);
    await new Promise((resolve) => { server = app.listen(0, resolve); });

    const res = await request(server, `/api/v1/usage/costs?client_id=${VALID_UUID}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.count).toBe(0);
  });

  it('returns 500 when db query fails', async () => {
    server.close();
    const failPool = { query: jest.fn().mockRejectedValue(new Error('connection refused')) };
    const app = createApp(failPool);
    await new Promise((resolve) => { server = app.listen(0, resolve); });

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(server, `/api/v1/usage/costs?client_id=${VALID_UUID}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    errorSpy.mockRestore();
  });

  it('does not leak error details in 500 response', async () => {
    server.close();
    const failPool = { query: jest.fn().mockRejectedValue(new Error('secret DB info')) };
    const app = createApp(failPool);
    await new Promise((resolve) => { server = app.listen(0, resolve); });

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(server, `/api/v1/usage/costs?client_id=${VALID_UUID}`);
    expect(JSON.stringify(res.body)).not.toContain('secret');
    errorSpy.mockRestore();
  });
});
