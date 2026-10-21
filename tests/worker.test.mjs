import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';

const service = 'ah-doc-renamer-worker-analyzer';
const endpoint = `https://${service}.oskar617.workers.dev/`;
const origin = 'https://ah-doc-renamer.pages.dev';
const env = { CORS_ORIGINS: origin, GEMINI_API_KEY: 'synthetic-key' };

test('Deployment name and health endpoint identify the same renamed Worker', async () => {
  const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(config, new RegExp(`^name = "${service}"`, 'm'));
  const result = await worker.fetch(new Request(endpoint), env);
  assert.equal(result.status, 200);
  const health = await result.json();
  assert.equal(health.service, service);
  assert.equal(health.model, 'gemini-3.1-flash-lite');
  assert.deepEqual(health.configured, { geminiKey: true, corsOrigins: true });
  assert.equal(JSON.stringify(health).includes(env.GEMINI_API_KEY), false);
});

test('Existing PWA origin retains CORS preflight access', async () => {
  const result = await worker.fetch(new Request(endpoint, {
    method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  }), env);
  assert.equal(result.status, 204);
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), origin);
  assert.match(result.headers.get('Access-Control-Allow-Methods'), /POST/);
  assert.match(result.headers.get('Access-Control-Allow-Headers'), /Content-Type/);
});

test('Renamed Worker preserves classification JSON and candidate section lookup', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(new URL(url).hostname, 'generativelanguage.googleapis.com');
    const body = JSON.parse(init.body);
    assert.match(body.contents[0].parts[0].text, /12 Example Road Testville/);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      docType: 'Architect', sectionNumber: 'WRONG', confidence: 'high', note: 'Synthetic floor plan',
      detectedAddress: '12 Example Road Testville', detectedJobCode: 'TEST',
    }) }] } }] });
  };
  try {
    const result = await worker.fetch(new Request(endpoint, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'synthetic.pdf', text: '12 Example Road Testville. Floor plan.', image: null,
        docTypes: [{ docType: 'Architect', sectionNumber: '1.1', note: 'Architectural drawings' }] }),
    }), env);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('Access-Control-Allow-Origin'), origin);
    assert.deepEqual(await result.json(), { docType: 'Architect', sectionNumber: '1.1', confidence: 'high',
      note: 'Synthetic floor plan', detectedAddress: '12 Example Road Testville', detectedJobCode: 'TEST' });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('Disallowed browser origins remain rejected before calling Gemini', async () => {
  const result = await worker.fetch(new Request(endpoint, { method: 'POST', headers: { Origin: 'https://not-allowed.example' }, body: '{}' }), env);
  assert.equal(result.status, 403);
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), null);
});

test('Invalid JSON still returns a useful client error', async () => {
  const result = await worker.fetch(new Request(endpoint, { method: 'POST', headers: { Origin: origin }, body: '{invalid' }), env);
  assert.equal(result.status, 400);
  assert.deepEqual(await result.json(), { error: 'Invalid JSON body' });
});
