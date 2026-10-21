// Microsoft-issued API access tokens only. Never accept Graph or ID tokens.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { HttpError, fetchJson } from './security-http.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jwksByTenant = new Map();
const GRAPH = 'https://graph.microsoft.com/v1.0';
const normalized = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

export async function rateLimit(binding, key) {
  if (typeof binding?.limit !== 'function') throw new HttpError(503, 'Request protection is unavailable');
  let result;
  try { result = await binding.limit({ key }); }
  catch { throw new HttpError(503, 'Request protection is unavailable'); }
  if (result?.success === false) throw new HttpError(429, 'Too many requests. Wait a minute before trying again.');
  if (result?.success !== true) throw new HttpError(503, 'Request protection is unavailable');
}

export async function protectIp(request, env) {
  // Cloudflare supplies this header. Never trust caller-selected X-Forwarded-For.
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) throw new HttpError(503, 'Request protection is unavailable');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  const key = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  await rateLimit(env.ANALYZER_IP_LIMITER, 'analyzer:ip:' + key);
}

export async function authenticate(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (header.length > 16384 || !/^Bearer [A-Za-z0-9_.-]+$/i.test(header)) {
    throw new HttpError(401, 'Sign in to AH Doc Renamer to use the analyzer');
  }
  const token = header.slice(7);
  const tenant = env.ENTRA_TENANT_ID;
  const clientId = env.ENTRA_CLIENT_ID;
  if (!GUID.test(tenant || '') || !GUID.test(clientId || '') || !env.ENTRA_CLIENT_SECRET) {
    throw new HttpError(503, 'Analyzer authentication is not configured');
  }
  if (!jwksByTenant.has(tenant)) {
    jwksByTenant.set(tenant, createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`),
      { timeoutDuration: 4000, cooldownDuration: 30000, cacheMaxAge: 3600000 },
    ));
  }
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(token, jwksByTenant.get(tenant), {
      algorithms: ['RS256'], issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
      audience: clientId, clockTolerance: 30,
      requiredClaims: ['exp', 'iat', 'nbf', 'sub', 'oid', 'tid', 'azp', 'scp', 'ver'],
    }));
  } catch {
    throw new HttpError(401, 'Analyzer sign-in is invalid or expired. Sign in again.');
  }
  if (claims.ver !== '2.0' || claims.tid !== tenant || claims.azp !== clientId ||
      !GUID.test(claims.oid || '') || typeof claims.sub !== 'string' || !claims.sub ||
      typeof claims.scp !== 'string' || !claims.scp.split(' ').includes('Analyzer.Invoke') ||
      claims.idtyp === 'app' || claims.iat > Date.now() / 1000 + 30) {
    throw new HttpError(401, 'Analyzer sign-in is invalid or expired. Sign in again.');
  }
  // Stable tenant/object ID, not email, IP, or unverified request JSON.
  await rateLimit(env.ANALYZER_USER_LIMITER, `analyzer:user:${tenant}:${claims.oid}`);
  return { token, oid: claims.oid };
}

export async function authorize(identity, env) {
  const signal = AbortSignal.timeout(12000);
  try {
    // Delegated OBO only. No client-credentials grant or application permissions.
    const result = await fetchJson(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.ENTRA_CLIENT_ID, client_secret: env.ENTRA_CLIENT_SECRET,
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        requested_token_use: 'on_behalf_of', assertion: identity.token,
        scope: 'https://graph.microsoft.com/.default',
      }).toString(),
    }, 65536, signal);
    if (typeof result.access_token !== 'string' || !result.access_token ||
        normalized(result.token_type) !== 'bearer') throw new Error('Invalid OBO response');
    const headers = { Authorization: 'Bearer ' + result.access_token, Accept: 'application/json' };
    const me = await fetchJson(GRAPH + '/me?$select=id,userPrincipalName,mail,userType', { headers }, 16384, signal);
    if (me.id !== identity.oid) throw new HttpError(403, 'This account cannot use the analyzer');
    const email = normalized(me.userPrincipalName);
    const reserved = (env.RESERVED_EMAILS || '').split(',').map(normalized).filter(Boolean);
    if (!email || reserved.includes(email) || reserved.includes(normalized(me.mail))) {
      throw new HttpError(403, 'This account cannot use the analyzer');
    }
    // Match the existing PWA policy using the verified directory UPN, not a
    // caller-supplied email or mutable mail/displayName field. Guests have #EXT# UPNs.
    if (email === normalized(env.ADMIN_EMAIL) && me.userType === 'Member') return;

    if (!env.ACCESS_SHAREPOINT_HOST || !env.ACCESS_SITE_PATH || !env.ACCESS_LIST_PATH) {
      throw new Error('Access list not configured');
    }
    const site = await fetchJson(GRAPH + '/sites/' + env.ACCESS_SHAREPOINT_HOST + ':' + env.ACCESS_SITE_PATH + '?$select=id', { headers }, 16384, signal);
    if (typeof site.id !== 'string' || !site.id) throw new Error('Invalid site');
    const drive = `/sites/${encodeURIComponent(site.id)}/drive`;
    const path = env.ACCESS_LIST_PATH.split('/').map(encodeURIComponent).join('/');
    const metadata = await fetchJson(GRAPH + drive + '/root:/' + path + '?$select=id,eTag,size,@microsoft.graph.downloadUrl', { headers }, 32768, signal);
    if (typeof metadata.id !== 'string' || !metadata.id || !metadata.eTag || metadata.size > 262144) throw new Error('Invalid access list');
    const download = new URL(metadata['@microsoft.graph.downloadUrl']);
    if (download.protocol !== 'https:' || download.hostname !== env.ACCESS_SHAREPOINT_HOST || download.port || download.username || download.password) {
      throw new Error('Invalid download host');
    }
    // Preauthenticated URL: do not forward the Graph token, follow redirects,
    // persist the URL, log it, or cache the authorization decision.
    const access = await fetchJson(download, {}, 262144, signal);
    const after = await fetchJson(GRAPH + drive + '/items/' + encodeURIComponent(metadata.id) + '?$select=id,eTag', { headers }, 16384, signal);
    if (after.id !== metadata.id || after.eTag !== metadata.eTag) throw new Error('Access list changed');
    if (!access || !Array.isArray(access.users) || !access.users.some(user => normalized(user?.email) === email)) {
      throw new HttpError(403, 'This account cannot use the analyzer');
    }
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) throw error;
    throw new HttpError(503, 'Cannot verify analyzer access. Try again later.');
  }
}
