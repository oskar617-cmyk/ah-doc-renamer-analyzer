import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import worker from '../worker.js';
import { readJson, fetchJson } from '../security-http.js';

const endpoint = 'https://ah-doc-renamer-worker-analyzer.oskar617.workers.dev/';
const origin = 'https://ah-doc-renamer.pages.dev';
const tenant = 'ff968505-cca0-4cd1-9f6d-68ce6eaf06c7';
const client = '3302edd3-505b-496d-ab66-707fa7a2d827';
const oid = '11111111-1111-4111-8111-111111111111';
const keys = await generateKeyPair('RS256');
const publicKey = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const email = 'person@auhs.com.au';
const sample = { filename: 'synthetic.pdf', text: '12 Example Road Testville. Floor plan.', image: null,
  docTypes: [{ docType: 'Architect', sectionNumber: '1.1', note: 'Architectural drawings' }] };
const ai = { docType: 'Architect', sectionNumber: 'WRONG', confidence: 'high', note: 'Synthetic floor plan',
  detectedAddress: '12 Example Road Testville', detectedJobCode: 'TEST' };

async function token(overrides = {}, signingKey = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'https://login.microsoftonline.com/' + tenant + '/v2.0', aud: client, tid: tenant,
    azp: client, oid, sub: 'user-subject', scp: 'Analyzer.Invoke', ver: '2.0', iat: now, nbf: now - 5, exp: now + 3600,
    ...overrides };
  for (const key of Object.keys(claims)) if (claims[key] === undefined) delete claims[key];
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(signingKey);
}

function setup(t, options = {}) {
  const calls = [], limitKeys = [];
  const env = {
    CORS_ORIGINS: origin, GEMINI_API_KEY: 'synthetic-gemini-secret', ENTRA_CLIENT_SECRET: 'synthetic-obo-secret',
    ENTRA_TENANT_ID: tenant, ENTRA_CLIENT_ID: client, ADMIN_EMAIL: 'oskar@auhs.com.au', RESERVED_EMAILS: 'hello@vaef.app',
    ACCESS_SHAREPOINT_HOST: 'auzziehomes.sharepoint.com', ACCESS_SITE_PATH: '/sites/AHSite',
    ACCESS_LIST_PATH: 'AH Apps Docs/AH Doc Renamer/allowed-users.json',
    ANALYZER_IP_LIMITER: { limit: async ({ key }) => { limitKeys.push(key); return { success: !options.ipLimited }; } },
    ANALYZER_USER_LIMITER: { limit: async ({ key }) => { limitKeys.push(key); return { success: !options.userLimited }; } },
  };
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input); calls.push({ url, init });
    if (url.pathname.endsWith('/discovery/v2.0/keys')) return Response.json({ keys: [publicKey] });
    if (url.pathname.endsWith('/oauth2/v2.0/token')) {
      assert.equal(init.method, 'POST');
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('requested_token_use'), 'on_behalf_of');
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      assert.equal(form.get('scope'), 'https://graph.microsoft.com/.default');
      assert.equal(form.get('client_secret'), env.ENTRA_CLIENT_SECRET);
      return options.oboFail ? Response.json({ error: 'synthetic-sensitive-error' }, { status: 400 }) :
        Response.json({ access_token: 'synthetic-graph-token', token_type: 'Bearer' });
    }
    if (url.hostname === 'graph.microsoft.com') {
      assert.equal(init.method || 'GET', 'GET');
      assert.equal(init.headers.Authorization, 'Bearer synthetic-graph-token');
      assert.equal(init.redirect, 'manual');
      if (url.pathname === '/v1.0/me') return Response.json({ id: options.wrongOid ? client : oid,
        userPrincipalName: options.email || email, mail: options.mail || email, userType: options.userType || 'Member' });
      if (options.graphFail) return Response.json({}, { status: 403 });
      if (url.pathname.includes('/root:/')) return Response.json({ id: 'access-file', eTag: 'etag-1', size: 100,
        '@microsoft.graph.downloadUrl': options.download || 'https://auzziehomes.sharepoint.com/download-access' });
      if (url.pathname.includes('/items/')) return Response.json({ id: 'access-file', eTag: options.changedEtag ? 'etag-2' : 'etag-1' });
      return Response.json({ id: 'site-id' });
    }
    if (url.hostname === 'auzziehomes.sharepoint.com') {
      assert.equal(init.headers, undefined, 'Graph bearer must not reach the download host');
      assert.equal(init.redirect, 'manual');
      return options.invalidList ? Response.json({ users: null }) : Response.json({ users: options.denied ? [] : [{ email }] });
    }
    assert.equal(url.hostname, 'generativelanguage.googleapis.com');
    assert.equal(url.search, '', 'AI secret must not be in the URL');
    assert.equal(init.headers['x-goog-api-key'], env.GEMINI_API_KEY);
    assert.equal(init.headers.Authorization, undefined, 'Microsoft bearer must not reach Gemini');
    if (options.aiFail) return new Response('synthetic-sensitive-error', { status: 500 });
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(ai) }] } }] });
  };
  return { env, calls, limitKeys, aiCalls: () => calls.filter(c => c.url.hostname === 'generativelanguage.googleapis.com') };
}
function request(bearer, { body = sample, method = 'POST', url = endpoint, headers = {} } = {}) {
  return new Request(url, { method, headers: { Origin: origin, 'Content-Type': 'application/json',
    'CF-Connecting-IP': '192.0.2.1', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}), ...headers },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
}

test('Outbound fetch is workerd-compatible and rejects redirects without replay', async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(init.redirect, 'manual', 'workerd only accepts follow or manual');
    return new Response(null, { status: 302, headers: { Location: 'https://evil.example' } });
  };
  await assert.rejects(fetchJson('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: 'Bearer synthetic-private-token' }, redirect: 'follow',
  }, 1024, AbortSignal.timeout(1000)), error => error.status === 503 &&
    !error.message.includes('synthetic-private-token'));
  assert.equal(calls, 1, 'No redirect destination is fetched');
});

test('Health is free, uncached and matches deployment name', async t => {
  const f = setup(t);
  const response = await worker.fetch(new Request(endpoint), f.env);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.service, 'ah-doc-renamer-worker-analyzer');
  assert.match(readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8'), /^name = "ah-doc-renamer-worker-analyzer"/m);
  assert.equal(JSON.stringify(health).includes('synthetic-'), false);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(f.calls.length, 0);
});

test('Only allowed origins receive Authorization preflight access', async t => {
  const f = setup(t);
  const response = await worker.fetch(request(null, { method: 'OPTIONS' }), f.env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  assert.equal((await worker.fetch(request(null, { headers: { Origin: 'https://evil.example' } }), f.env)).status, 403);
  assert.equal(f.calls.length, 0);
});

test('POST and selftest require a token even without Origin', async t => {
  const f = setup(t);
  for (const req of [request(null), request(null, { method: 'GET', url: endpoint + '?selftest=1' })]) {
    req.headers.delete('Origin');
    const response = await worker.fetch(req, f.env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer');
  }
  assert.equal(f.calls.length, 0);
});

test('Approved user preserves classification response and server section lookup', async t => {
  const f = setup(t);
  const response = await worker.fetch(request(await token()), f.env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...ai, sectionNumber: '1.1' });
  assert.equal(f.aiCalls().length, 1);
  assert.ok(f.limitKeys.includes('analyzer:user:' + tenant + ':' + oid));
  assert.equal(f.limitKeys.some(key => key.includes(email) || key.includes('192.0.2.1')), false);
});

test('Wrong audience/issuer/tenant/client/scope, ID/app/expired/future/forged tokens fail closed', async t => {
  const f = setup(t), now = Math.floor(Date.now() / 1000);
  for (const claims of [{ aud: '00000003-0000-0000-c000-000000000000' }, { scp: undefined }, { scp: 'User.Read' },
    { iss: 'https://evil.example' }, { tid: client }, { azp: tenant }, { exp: now - 120 }, { exp: undefined },
    { nbf: now + 120 }, { iat: now + 120 }, { oid: '' }, { ver: '1.0' }, { idtyp: 'app' }, { sub: '' }]) {
    assert.equal((await worker.fetch(request(await token(claims)), f.env)).status, 401, JSON.stringify(claims));
  }
  const otherKeys = await generateKeyPair('RS256');
  assert.equal((await worker.fetch(request(await token({}, otherKeys.privateKey)), f.env)).status, 401);
  assert.equal((await worker.fetch(request('e30.e30.fake'), f.env)).status, 401);
  assert.equal(f.aiCalls().length, 0);
  assert.equal(f.calls.some(call => call.url.pathname.endsWith('/token')), false);
});

test('Unlisted users, mismatched identities, reserved emails and mail spoofing fail closed', async t => {
  for (const options of [{ denied: true }, { email: 'hello@vaef.app' }, { mail: 'hello@vaef.app' },
    { wrongOid: true }, { email: 'guest#EXT#@auhs.onmicrosoft.com', mail: 'oskar@auhs.com.au', userType: 'Guest' }]) {
    const f = setup(t, options);
    assert.equal((await worker.fetch(request(await token()), f.env)).status, 403);
    assert.equal(f.aiCalls().length, 0);
  }
});

test('Admin bypasses the list only after verified directory identity', async t => {
  const f = setup(t, { email: 'oskar@auhs.com.au', graphFail: true });
  assert.equal((await worker.fetch(request(await token()), f.env)).status, 200);
  assert.equal(f.calls.some(call => call.url.pathname.includes('/sites/')), false);
});

test('Broken auth dependencies, changed/malformed lists and unsafe downloads fail closed', async t => {
  for (const options of [{ oboFail: true }, { graphFail: true }, { changedEtag: true }, { invalidList: true },
    { download: 'https://attacker.example/data' }]) {
    const f = setup(t, options);
    const response = await worker.fetch(request(await token()), f.env);
    assert.ok([403, 503].includes(response.status));
    assert.doesNotMatch(await response.text(), /synthetic-|Bearer|access_token/);
    assert.equal(f.aiCalls().length, 0);
  }
});

test('IP/user throttles return 429 + Retry-After before OBO or AI including selftest', async t => {
  for (const options of [{ ipLimited: true }, { userLimited: true }]) {
    const f = setup(t, options);
    for (const req of [request(await token()), request(await token(), { method: 'GET', url: endpoint + '?selftest=1' })]) {
      const response = await worker.fetch(req, f.env);
      assert.equal(response.status, 429);
      assert.equal(response.headers.get('Retry-After'), '60');
    }
    assert.equal(f.calls.some(call => call.url.pathname.endsWith('/token')), false);
    assert.equal(f.aiCalls().length, 0);
  }
});

test('Missing/broken configuration never disables protection', async t => {
  const f = setup(t);
  for (const name of ['ANALYZER_IP_LIMITER', 'ANALYZER_USER_LIMITER', 'ENTRA_CLIENT_SECRET']) {
    assert.equal((await worker.fetch(request(await token()), { ...f.env, [name]: undefined })).status, 503);
  }
  const req = request(await token()); req.headers.delete('CF-Connecting-IP');
  assert.equal((await worker.fetch(req, f.env)).status, 503);
  assert.equal((await worker.fetch(request(await token()), { ...f.env,
    ANALYZER_IP_LIMITER: { limit: async () => { throw new Error('private details'); } } })).status, 503);
  assert.equal(f.aiCalls().length, 0);
});

test('Invalid body, JSON, media, duplicate types and oversized content never reach OBO/AI', async t => {
  const f = setup(t), bearer = await token();
  for (const body of ['{invalid', null, [], { ...sample, docTypes: [{ docType: '' }] },
    { ...sample, docTypes: Array(501).fill(sample.docTypes[0]) }, { ...sample, image: 'data:image/svg+xml;base64,AAAA' },
    { ...sample, image: 'data:image/png;base64,###' }, { ...sample, docTypes: [...sample.docTypes, ...sample.docTypes] }]) {
    assert.equal((await worker.fetch(request(bearer, { body }), f.env)).status, 400);
  }
  assert.equal((await worker.fetch(request(bearer, { headers: { 'Content-Type': 'text/plain' } }), f.env)).status, 415);
  assert.equal((await worker.fetch(request(bearer, { headers: { 'Content-Length': String(9 * 1024 * 1024) } }), f.env)).status, 413);
  assert.equal(f.calls.some(call => call.url.pathname.endsWith('/token')), false);
});

test('AI failure is non-200, redacted and never automatically retried', async t => {
  const f = setup(t, { aiFail: true });
  const result = await worker.fetch(request(await token()), f.env);
  assert.equal(result.status, 502);
  assert.doesNotMatch(await result.text(), /synthetic-|secret|Bearer/);
  assert.equal(f.aiCalls().length, 1);
});

test('Authenticated selftest uses the same protection and only one AI call', async t => {
  const f = setup(t);
  const result = await worker.fetch(request(await token(), { method: 'GET', url: endpoint + '?selftest=1' }), f.env);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).geminiOk, true);
  assert.equal(f.aiCalls().length, 1);
});

test('JSON reader bounds actual streaming bytes and cancels stalled streams', async () => {
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(100)); c.close(); } }));
  await assert.rejects(readJson(response, 10), error => error.status === 413);
  let cancelled = false;
  const hanging = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10);
  try { await assert.rejects(readJson(hanging, 100, controller.signal), /abort/i); }
  finally { clearTimeout(timer); }
  assert.equal(cancelled, true);
});
