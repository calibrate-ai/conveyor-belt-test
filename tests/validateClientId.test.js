const http = require('http');
const app = require('../backend/server');
const { getAlertCounters, resetAlertCounters } = require('../backend/middleware/validateClientId');

let server;

beforeAll((done) => {
  server = app.listen(0, done);
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  resetAlertCounters();
});

function request(path, headers = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.get(
      `http://127.0.0.1:${port}${path}`,
      { headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: JSON.parse(data),
          });
        });
      },
    );
    req.on('error', reject);
  });
}

const VALID_CLIENT_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('client_id validation middleware (F-002)', () => {
  describe('health endpoint bypass', () => {
    it('allows /health without x-client-id', async () => {
      const res = await request('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('missing x-client-id', () => {
    it('returns 401 with error when header is absent', async () => {
      const res = await request('/api/events');
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Missing x-client-id/);
      expect(res.body.code).toBe('F-002');
      expect(res.body.alert_type).toBe('missing_client_id');
    });

    it('increments missing alert counter', async () => {
      await request('/api/events');
      await request('/api/events');
      const counters = getAlertCounters();
      expect(counters.missing).toBe(2);
      expect(counters.invalid).toBe(0);
    });
  });

  describe('invalid x-client-id', () => {
    it('returns 400 for non-UUID value', async () => {
      const res = await request('/api/events', { 'x-client-id': 'not-a-uuid' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid x-client-id format/);
      expect(res.body.code).toBe('F-002');
      expect(res.body.alert_type).toBe('invalid_client_id');
    });

    it('returns 400 for empty string', async () => {
      const res = await request('/api/events', { 'x-client-id': '' });
      // Empty string → missing or invalid; middleware treats empty as missing
      expect([400, 401]).toContain(res.status);
    });

    it('returns 400 for UUID-like but wrong version', async () => {
      // Version 1 UUID (first digit of third group is 1, not 4)
      const res = await request('/api/events', { 'x-client-id': '550e8400-e29b-11d4-a716-446655440000' });
      expect(res.status).toBe(400);
    });

    it('increments invalid alert counter', async () => {
      await request('/api/events', { 'x-client-id': 'bad' });
      const counters = getAlertCounters();
      expect(counters.invalid).toBe(1);
      expect(counters.missing).toBe(0);
    });
  });

  describe('valid x-client-id', () => {
    it('passes through to route handler with valid UUID v4', async () => {
      // No /api/events route exists → should get 404 (passed middleware)
      const res = await request('/api/events', { 'x-client-id': VALID_CLIENT_ID });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not found');
    });

    it('does not trigger any alerts', async () => {
      await request('/api/events', { 'x-client-id': VALID_CLIENT_ID });
      const counters = getAlertCounters();
      expect(counters.missing).toBe(0);
      expect(counters.invalid).toBe(0);
    });

    it('accepts uppercase UUID', async () => {
      const res = await request('/api/events', { 'x-client-id': VALID_CLIENT_ID.toUpperCase() });
      expect(res.status).toBe(404); // passed validation
    });
  });

  describe('alert log output', () => {
    it('emits structured JSON to stderr for missing client_id', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      await request('/api/events');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(errorSpy.mock.calls[0][0]);
      expect(logged.level).toBe('alert');
      expect(logged.code).toBe('F-002');
      expect(logged.type).toBe('missing_client_id');
      expect(logged.timestamp).toBeDefined();
      errorSpy.mockRestore();
    });

    it('emits structured JSON to stderr for invalid client_id', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      await request('/api/events', { 'x-client-id': 'garbage' });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(errorSpy.mock.calls[0][0]);
      expect(logged.level).toBe('alert');
      expect(logged.code).toBe('F-002');
      expect(logged.type).toBe('invalid_client_id');
      expect(logged.detail).toMatch(/garbage/);
      errorSpy.mockRestore();
    });
  });
});
