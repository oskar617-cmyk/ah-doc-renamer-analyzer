import { protectIp, authenticate, authorize } from './auth.js';
import { HttpError, readJson } from './security-http.js';
import { classify, MODEL } from './analyzer.js';

// AH Doc Renamer — analyzer Worker
// ---------------------------------------------------------------------------
// Cloudflare Worker (native module format). The AI brain for the AH Doc Renamer
// PWA. It proxies Google Gemini to classify a single Auzzie Homes construction
// document into one of a given list of candidate types, and drafts a short note.
//
// It reads the document CONTENT (extracted text + first-page image), not the
// filename. For drawings it is told to read the title block (bottom-right of the
// sheet) for the sheet name / drawing number / discipline / revision.
//
// Secrets (set in Cloudflare — NEVER committed to this repo):
//   GEMINI_API_KEY  Google AI Studio (Gemini Developer API) key
//   ENTRA_CLIENT_SECRET  Dedicated confidential-client credential for delegated OBO
//   CORS_ORIGINS    Comma-separated allowed browser origins, e.g.
//                   https://ah-doc-renamer.pages.dev,https://oskar617-cmyk.github.io
//
// Contract with the PWA's js/classify.js:
//   Request  POST application/json:
//     Authorization: Bearer <Entra v2 API access token, Analyzer.Invoke scope>
//     { filename: string,
//       text:     string,          // extracted text, up to ~6000 chars
//       image:    string | null,   // first page rendered to a dataURL, or null
//       docTypes: [ { docType, sectionNumber, note } ],   // candidate types
//       examples: [ { snippet, docType } ] }              // optional past user labels (few-shot); may be empty/absent
//   Response application/json:
//     { docType:         string,   // exactly one candidate, or "" if none fit
//       sectionNumber:   string,   // section number of the matched type
//       confidence:      "high" | "medium" | "low",
//       note:            string,   // short AI draft note describing the file
//       detectedAddress: string,   // address/site read from content (title block), or ""
//       detectedJobCode: string }  // short job code (e.g. GV / SH / CDL), or ""
// ---------------------------------------------------------------------------

// Bump on every release. Reported by the GET health check, and used in the zip
// filename — this is the Worker's equivalent of a PWA's service-worker VERSION.
// v0.05: Rename the existing CF service; model and classification contract unchanged.
const VERSION = 'v0.05';

const MAX_TEXT_CHARS = 6000;   // defensive cap (PWA already limits to ~6000)
const MAX_NOTE_CHARS = 500;    // keep the draft note short
const MAX_ADDR_CHARS = 200;    // cap detectedAddress length
const MAX_CODE_CHARS = 30;     // cap detectedJobCode length
const MAX_EXAMPLES = 40;       // cap how many few-shot examples reach the model
const MAX_EXAMPLE_CHARS = 300; // cap each example snippet length
const NONE = '__NONE__';       // sentinel the model returns when nothing fits

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowOrigin = pickAllowedOrigin(origin, env.CORS_ORIGINS);

    if (new URL(request.url).pathname !== '/') return json({ error: 'Not found' }, 404, allowOrigin);
    if (origin && !allowOrigin) return json({ error: 'Origin not allowed' }, 403, '');

    // CORS is a browser policy, not authentication.
    if (request.method === 'OPTIONS') {
      if (!allowOrigin) return json({ error: 'Origin not allowed' }, 403, '');
      return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
    }

    // Free public liveness; any self-test goes through the same security gate.
    //   GET /            -> liveness + which secrets are wired (no secret values shown)
    //   GET /?selftest=1 -> authenticated/authorized/limited real Gemini call
    if (request.method === 'GET') {
      const url = new URL(request.url);
      if (url.searchParams.get('selftest') === '1') {
        try {
          await protectIp(request, env);
          await authorize(await authenticate(request, env), env);
          return await selftest(env, allowOrigin);
        } catch (error) { return securityError(error, allowOrigin); }
      }
      return json({
        ok: true,
        service: 'ah-doc-renamer-worker-analyzer',
        version: VERSION,
        model: MODEL,
        configured: {
          geminiKey: !!env.GEMINI_API_KEY,
          corsOrigins: !!env.CORS_ORIGINS,
        },
      }, 200, allowOrigin);
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, allowOrigin);
    }

    // Verify identity before reading untrusted bytes. Calls without Origin use
    // exactly the same authentication and limiters as browser requests.
    let body;
    try {
      await protectIp(request, env);
      const identity = await authenticate(request, env);
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
        throw new HttpError(415, 'Send application/json');
      }
      body = await readJson(request, 8 * 1024 * 1024, AbortSignal.timeout(5000));
      validateInput(body);
      await authorize(identity, env);
    } catch (error) { return securityError(error, allowOrigin); }

    const filename = typeof body.filename === 'string' ? body.filename : '';
    let text = typeof body.text === 'string' ? body.text : '';
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
    const image = typeof body.image === 'string' ? body.image : null;

    if (!Array.isArray(body.docTypes)) {
      return json({ error: 'docTypes must be an array' }, 400, allowOrigin);
    }

    const candidates = body.docTypes
      .filter((d) => d && typeof d.docType === 'string' && d.docType.trim() !== '')
      .map((d) => ({
        docType: d.docType.trim(),
        sectionNumber: typeof d.sectionNumber === 'string' ? d.sectionNumber : '',
        note: typeof d.note === 'string' ? d.note : '',
      }));

    // Optional few-shot examples: how the user labelled similar documents before.
    // Tolerates missing / empty / malformed entries.
    const examples = (Array.isArray(body.examples) ? body.examples : [])
      .filter((e) => e && typeof e.snippet === 'string' && typeof e.docType === 'string'
        && e.snippet.trim() !== '' && e.docType.trim() !== '')
      .slice(0, MAX_EXAMPLES)
      .map((e) => ({
        snippet: e.snippet.trim().slice(0, MAX_EXAMPLE_CHARS),
        docType: e.docType.trim(),
      }));

    // Always-valid empty result — returned on ANY failure so the PWA, which
    // expects the contract shape, never crashes on a bad/empty response.
    const emptyResult = { docType: '', sectionNumber: '', confidence: 'low', note: '', detectedAddress: '', detectedJobCode: '' };

    if (!env.GEMINI_API_KEY) {
      return json({ ...emptyResult, error: 'Analyzer is not configured' }, 503, allowOrigin);
    }

    try {
      const ai = await classify({
        apiKey: env.GEMINI_API_KEY,
        filename,
        text,
        image,
        candidates,
        examples,
      });

      // Resolve the model's choice into the contract shape.
      let docType = typeof ai.docType === 'string' ? ai.docType : '';
      let sectionNumber = '';
      if (docType === NONE || docType === '') {
        docType = '';
      } else {
        const match = candidates.find((c) => c.docType === docType);
        if (match) {
          // Look the section number up ourselves — never trust the model to copy it.
          sectionNumber = match.sectionNumber;
        } else {
          // Off-list value (shouldn't happen with the enum) -> treat as no match.
          docType = '';
        }
      }

      const confidence = ['high', 'medium', 'low'].includes(ai.confidence) ? ai.confidence : 'low';
      let note = typeof ai.note === 'string' ? ai.note.trim() : '';
      if (note.length > MAX_NOTE_CHARS) note = note.slice(0, MAX_NOTE_CHARS);

      // detectedAddress / detectedJobCode are independent of the type — keep them
      // even when docType resolves to "" (no matching candidate).
      let detectedAddress = typeof ai.detectedAddress === 'string' ? ai.detectedAddress.trim() : '';
      if (detectedAddress.length > MAX_ADDR_CHARS) detectedAddress = detectedAddress.slice(0, MAX_ADDR_CHARS);
      let detectedJobCode = typeof ai.detectedJobCode === 'string' ? ai.detectedJobCode.trim() : '';
      if (detectedJobCode.length > MAX_CODE_CHARS) detectedJobCode = detectedJobCode.slice(0, MAX_CODE_CHARS);

      return json({ docType, sectionNumber, confidence, note, detectedAddress, detectedJobCode }, 200, allowOrigin);
    } catch {
      return json({ ...emptyResult, error: 'Classification failed. No automatic retry was made.' }, 502, allowOrigin);
    }
  },
};

// One-shot end-to-end check: confirms GEMINI_API_KEY actually works and the model
// name is valid. Makes ONE tiny real Gemini call. Exposes no secret values.
async function selftest(env, allowOrigin) {
  const out = {
    selftest: true,
    version: VERSION,
    model: MODEL,
    configured: {
      geminiKey: !!env.GEMINI_API_KEY,
      corsOrigins: !!env.CORS_ORIGINS,
    },
    geminiOk: false,
    detail: '',
  };
  if (!env.GEMINI_API_KEY) {
    out.detail = 'GEMINI_API_KEY is not set';
    return json(out, 200, allowOrigin);
  }
  try {
    const ai = await classify({
      apiKey: env.GEMINI_API_KEY,
      filename: 'selftest.pdf',
      text: 'Ground floor plan. Drawing number GV-A-101. Revision C. Project address: 12 Smith Street, Geelong VIC 3220. Job code: GV. Scale 1:100.',
      image: null,
      candidates: [
        { docType: 'Architectural Plan', sectionNumber: 'A-100', note: 'floor plans, elevations, sections' },
        { docType: 'Structural Plan', sectionNumber: 'S-100', note: 'footings, framing, steel' },
      ],
    });
    out.geminiOk = true;
    out.sample = {
      docType: ai.docType,
      confidence: ai.confidence,
      detectedAddress: ai.detectedAddress,
      detectedJobCode: ai.detectedJobCode,
    };
    out.detail = 'Gemini responded and the output parsed correctly.';
  } catch {
    out.detail = 'Gemini call failed. No automatic retry was made.';
  }
  return json(out, out.geminiOk ? 200 : 502, allowOrigin);
}

// --- Helpers ----------------------------------------------------------------

function pickAllowedOrigin(origin, corsOrigins) {
  if (!origin || !corsOrigins) return '';
  const allowed = corsOrigins
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const norm = origin.replace(/\/+$/, '');
  return allowed.includes(norm) ? origin : '';
}

function corsHeaders(allowOrigin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowOrigin) h['Access-Control-Allow-Origin'] = allowOrigin;
  return h;
}

function json(obj, status, allowOrigin, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders(allowOrigin),
      ...extraHeaders,
    },
  });
}

function securityError(error, origin) {
  const status = error instanceof HttpError ? error.status : 503;
  return json({ error: error instanceof HttpError ? error.message : 'Analyzer protection is unavailable' }, status, origin,
    status === 429 ? { 'Retry-After': '60' } : status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {});
}

function validateInput(body) {
  const invalid = () => { throw new HttpError(400, 'Invalid classifier request'); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
  if (body.filename != null && (typeof body.filename !== 'string' || body.filename.length > 1024)) invalid();
  if (body.text != null && (typeof body.text !== 'string' || body.text.length > 100000)) invalid();
  if (!Array.isArray(body.docTypes) || body.docTypes.length > 500) invalid();
  const seen = new Set();
  for (const entry of body.docTypes) {
    if (!entry || typeof entry.docType !== 'string' || !entry.docType.trim() || entry.docType.length > 200 ||
        entry.docType.trim() === NONE || seen.has(entry.docType.trim()) ||
        (entry.sectionNumber != null && (typeof entry.sectionNumber !== 'string' || entry.sectionNumber.length > 100)) ||
        (entry.note != null && (typeof entry.note !== 'string' || entry.note.length > 2000))) invalid();
    seen.add(entry.docType.trim());
  }
  if (body.examples != null && (!Array.isArray(body.examples) || body.examples.length > MAX_EXAMPLES)) invalid();
  for (const example of body.examples || []) {
    if (!example || typeof example.snippet !== 'string' || example.snippet.length > 2000 ||
        typeof example.docType !== 'string' || !seen.has(example.docType.trim())) invalid();
  }
  if (body.image != null) {
    if (typeof body.image !== 'string' || body.image.length > 7 * 1024 * 1024) invalid();
    const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.image);
    if (!match || match[1].length % 4 !== 0) invalid();
  }
}
