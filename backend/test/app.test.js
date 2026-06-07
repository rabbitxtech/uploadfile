import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { openapiDocument } from '../src/openapi.js';

describe('app', () => {
  const app = buildApp();

  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('serves the OpenAPI document', async () => {
    const res = await request(app).get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.0.3');
    expect(res.body.paths['/api/auth/login']).toBeDefined();
  });

  it('unknown route returns 404 json', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
  });
});

describe('openapi document', () => {
  it('describes the core auth + files endpoints', () => {
    expect(openapiDocument.paths['/api/auth/register']).toBeDefined();
    expect(openapiDocument.paths['/api/files/{id}']).toBeDefined();
    expect(openapiDocument.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
  });
});
