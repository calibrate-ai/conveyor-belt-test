const http = require('http');
const app = require('../backend/server');

let server;

beforeAll((done) => {
  server = app.listen(0, done);
});

afterAll((done) => {
  server.close(done);
});

function request(path) {
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

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns a valid ISO timestamp', async () => {
    const res = await request('/health');
    const ts = new Date(res.body.timestamp);
    expect(ts.toISOString()).toBe(res.body.timestamp);
  });

  it('returns uptime as a number', async () => {
    const res = await request('/health');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThan(0);
  });

  it('responds with application/json content-type', async () => {
    const res = await request('/health');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

describe('Unknown routes', () => {
  it('returns 401 without x-client-id (middleware rejects first)', async () => {
    const res = await request('/nonexistent');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('F-002');
  });

  it('returns 404 with valid x-client-id for unknown paths', async () => {
    const { port } = server.address();
    const res = await new Promise((resolve, reject) => {
      http.get(
        `http://127.0.0.1:${port}/nonexistent`,
        { headers: { 'x-client-id': '550e8400-e29b-41d4-a716-446655440000' } },
        (r) => {
          let data = '';
          r.on('data', (chunk) => { data += chunk; });
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
        },
      ).on('error', reject);
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  it('returns application/json content-type', async () => {
    const res = await request('/nonexistent');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
