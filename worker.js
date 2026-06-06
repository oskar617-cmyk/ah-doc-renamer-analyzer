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
//   CORS_ORIGINS    Comma-separated allowed browser origins, e.g.
//                   https://ah-doc-renamer.pages.dev,https://oskar617-cmyk.github.io
//
// Contract with the PWA's js/classify.js (DO NOT CHANGE):
//   Request  POST application/json:
//     { filename: string,
//       text:     string,          // extracted text, up to ~6000 chars
//       image:    string | null,   // first page rendered to a dataURL, or null
//       docTypes: [ { docType, sectionNumber, note } ] }  // candidate types
//   Response application/json:
//     { docType:       string,     // exactly one candidate, or "" if none fit
//       sectionNumber: string,     // section number of the matched type
//       confidence:    "high" | "medium" | "low",
//       note:          string }    // short AI draft note describing the file
// ---------------------------------------------------------------------------

// Bump on every release. Reported by the GET health check, and used in the zip
// filename — this is the Worker's equivalent of a PWA's service-worker VERSION.
const VERSION = 'v0.02';

// Locked to the model confirmed in chat. To upgrade to gemini-3.5-flash later
// (paid tier, marginally stronger on messy title blocks) change ONLY this line.
const MODEL = 'gemini-3.1-flash-lite';

const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const MAX_TEXT_CHARS = 6000;   // defensive cap (PWA already limits to ~6000)
const MAX_NOTE_CHARS = 500;    // keep the draft note short
const NONE = '__NONE__';       // sentinel the model returns when nothing fits

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowOrigin = pickAllowedOrigin(origin, env.CORS_ORIGINS);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
    }

    // Health check / self-test — open in a browser to confirm the Worker is live.
    //   GET /            -> liveness + which secrets are wired (no secret values shown)
    //   GET /?selftest=1 -> makes ONE real Gemini call to confirm the key works
    if (request.method === 'GET') {
      const url = new URL(request.url);
      if (url.searchParams.get('selftest') === '1') {
        return await selftest(env, allowOrigin);
      }
      return json({
        ok: true,
        service: 'ah-doc-renamer-analyzer',
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

    // Block browser calls from origins we did not authorise (protects the
    // Gemini quota). Calls with no Origin header (curl / server-to-server) pass.
    if (origin && !allowOrigin) {
      return json({ error: 'Origin not allowed' }, 403, '');
    }

    // Parse and lightly validate the request body
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, allowOrigin);
    }

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

    // Always-valid empty result — returned on ANY failure so the PWA, which
    // expects the contract shape, never crashes on a bad/empty response.
    const emptyResult = { docType: '', sectionNumber: '', confidence: 'low', note: '' };

    if (!env.GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY is not set');
      return json({ ...emptyResult, error: 'Server not configured (missing GEMINI_API_KEY)' }, 200, allowOrigin);
    }

    try {
      const ai = await classify({
        apiKey: env.GEMINI_API_KEY,
        filename,
        text,
        image,
        candidates,
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

      return json({ docType, sectionNumber, confidence, note }, 200, allowOrigin);
    } catch (err) {
      console.error('Classify failed:', err && err.message ? err.message : err);
      return json({ ...emptyResult, error: 'Classification failed' }, 200, allowOrigin);
    }
  },
};

// --- Gemini call ------------------------------------------------------------

async function classify({ apiKey, filename, text, image, candidates }) {
  const prompt = buildPrompt({ filename, text, candidates });
  const schema = buildSchema(candidates);

  const parts = [{ text: prompt }];
  if (image) {
    const img = parseDataUrl(image);
    if (img) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
  }

  const reqBody = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: schema,
      maxOutputTokens: 8192,
    },
  };

  const resp = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Gemini ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  const out = extractText(data);
  if (!out) throw new Error('Empty model output');

  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    // Salvage a JSON object if the model wrapped it in any extra prose.
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Model output was not JSON');
    parsed = JSON.parse(m[0]);
  }

  return {
    docType: typeof parsed.docType === 'string' ? parsed.docType : '',
    confidence: typeof parsed.confidence === 'string' ? parsed.confidence : 'low',
    note: typeof parsed.note === 'string' ? parsed.note : '',
  };
}

function buildPrompt({ filename, text, candidates }) {
  const list = candidates.length
    ? candidates
        .map((c, i) => {
          const sec = c.sectionNumber ? ` [${c.sectionNumber}]` : '';
          const meaning = c.note ? ` — ${c.note}` : '';
          return `${i + 1}. ${c.docType}${sec}${meaning}`;
        })
        .join('\n')
    : '(no candidate types provided)';

  return [
    'You classify a single construction / architecture document for an Australian residential builder (Auzzie Homes).',
    '',
    'Decide which ONE of the candidate document types below best matches THIS document, based on the document CONTENT — not the filename. The filename is often generic or wrong; treat it as a weak hint only.',
    '',
    'For drawings, the most reliable identifier is the TITLE BLOCK, usually in the bottom-right corner of the page. Read it carefully (from the page image when one is provided): it gives the sheet name, drawing number, discipline (Architectural / Structural / Hydraulic / Electrical / Civil / Landscape / Survey / etc.) and revision. Prefer the title block over everything else when present.',
    '',
    'Rules:',
    '- Choose exactly one docType value from the candidate list.',
    `- If none of the candidates genuinely fit (or no candidates are given), set docType to exactly ${NONE}.`,
    '- confidence: "high" when the title block or text states it clearly; "medium" when you infer it with good evidence; "low" when guessing.',
    '- note: one or two short, factual sentences describing the document, to be edited later by a person. Include the strongest identifiers you found (e.g. drawing number + sheet title + revision; or for a letter / report: subject, sender, date). Do not just repeat the docType as the whole note.',
    '',
    'Candidate document types:',
    list,
    '',
    `Filename: ${filename || '(none)'}`,
    '',
    'Extracted text (may be truncated; may be empty for scanned drawings):',
    '"""',
    text || '(no extractable text)',
    '"""',
  ].join('\n');
}

function buildSchema(candidates) {
  const docTypeEnum = candidates.map((c) => c.docType);
  docTypeEnum.push(NONE);
  return {
    type: 'OBJECT',
    properties: {
      docType: { type: 'STRING', enum: docTypeEnum },
      confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
      note: { type: 'STRING' },
    },
    required: ['docType', 'confidence', 'note'],
  };
}

function extractText(data) {
  try {
    const parts = data.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim();
  } catch {
    return '';
  }
}

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
      text: 'Ground floor plan. Drawing number A-101. Revision C. Scale 1:100.',
      image: null,
      candidates: [
        { docType: 'Architectural Plan', sectionNumber: 'A-100', note: 'floor plans, elevations, sections' },
        { docType: 'Structural Plan', sectionNumber: 'S-100', note: 'footings, framing, steel' },
      ],
    });
    out.geminiOk = true;
    out.sample = { docType: ai.docType, confidence: ai.confidence };
    out.detail = 'Gemini responded and the output parsed correctly.';
  } catch (err) {
    out.detail = 'Gemini call failed: ' + (err && err.message ? err.message : String(err));
  }
  return json(out, 200, allowOrigin);
}

// --- Helpers ----------------------------------------------------------------

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  const meta = dataUrl.slice(5, comma); // between 'data:' and the first comma
  const data = dataUrl.slice(comma + 1);
  if (!data || !/;base64$/i.test(meta)) return null; // expect base64 image data
  let mimeType = meta.replace(/;base64$/i, '');
  if (!mimeType) mimeType = 'image/png';
  if (!/^image\//i.test(mimeType)) return null; // images only; ignore anything else
  return { mimeType, data };
}

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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowOrigin) h['Access-Control-Allow-Origin'] = allowOrigin;
  return h;
}

function json(obj, status, allowOrigin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(allowOrigin),
    },
  });
}
