import { describe, expect, it } from 'vitest';

import { GET } from './route';

/**
 * U1 — tracer bullet for the liveness endpoint.
 *
 * The handler is exercised directly (no HTTP server) with a real `Request` and
 * asserted on the `Response` the consumer observes: status, body and headers.
 * Contract under test: GET /api/v1/health -> 200 { status: 'ok' },
 * Cache-Control: no-store.
 */
describe('GET /api/v1/health', () => {
  const request = (): Request => new Request('http://localhost/api/v1/health');

  it('responds 200 with the body { status: "ok" }', async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('declares a JSON content type', async () => {
    const response = await GET(request());

    expect(response.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('forbids caching with Cache-Control: no-store', async () => {
    const response = await GET(request());

    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
