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
// Contract with the PWA's js/classify.js:
//   Request  POST application/json:
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
const VERSION = 'v0.04';

// Locked to the model confirmed in chat. To upgrade to gemini-3.5-flash later
// (paid tier, marginally stronger on messy title blocks) change ONLY this line.
const MODEL = 'gemini-3.1-flash-lite';

const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

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
    } catch (err) {
      console.error('Classify failed:', err && err.message ? err.message : err);
      return json({ ...emptyResult, error: 'Classification failed' }, 200, allowOrigin);
    }
  },
};

// --- Gemini call ------------------------------------------------------------

async function classify({ apiKey, filename, text, image, candidates, examples = [] }) {
  const prompt = buildPrompt({ filename, text, candidates, examples });
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
    detectedAddress: typeof parsed.detectedAddress === 'string' ? parsed.detectedAddress : '',
    detectedJobCode: typeof parsed.detectedJobCode === 'string' ? parsed.detectedJobCode : '',
  };
}

function buildPrompt({ filename, text, candidates, examples = [] }) {
  const list = candidates.length
    ? candidates
        .map((c, i) => {
          const sec = c.sectionNumber ? ` [${c.sectionNumber}]` : '';
          const meaning = c.note ? ` — ${c.note}` : '';
          return `${i + 1}. ${c.docType}${sec}${meaning}`;
        })
        .join('\n')
    : '(no candidate types provided)';

  const lines = [
    'You classify a single construction / architecture document for an Australian residential builder (Auzzie Homes).',
    '',
    'CORE PRINCIPLE — CONTENT FIRST, FILENAME IS ONLY A WEAK HINT:',
    '- Decide the document type from its CONTENT, never from its filename when any content is readable.',
    '- The single most important source is the drawing TITLE BLOCK (the drawing frame) — usually in the BOTTOM-RIGHT corner, or a vertical strip down the RIGHT-HAND side. It holds the sheet / drawing name, the discipline (Architectural / Structural / Hydraulic / Electrical / Civil / Landscape / Survey / etc.), the project address, and the drawing number. Read it FIRST and prefer it over everything else.',
    '- The page image provided is HIGH RESOLUTION. Read the text inside the title block carefully from the image. The extracted "text" field is often sparse or empty (vector drawings frequently yield no extractable text), so the IMAGE is usually MORE important than the text.',
    '- The filename is only a WEAK HINT and is OFTEN WRONG — external designers name files arbitrarily. NEVER classify on the filename alone when any content is readable.',
    '- If the content (title block) and the filename CONFLICT, always trust the content and ignore the filename.',
    '- Fall back to the filename ONLY when both the image and the text are completely unreadable or contain no useful information.',
    '',
    'Rules:',
    '- Choose exactly one docType value from the candidate list.',
    `- If none of the candidates genuinely fit (or no candidates are given), set docType to exactly ${NONE}.`,
    '- confidence: "high" when the title block or text states it clearly; "medium" when you infer it with good evidence; "low" when guessing.',
    '- note: one or two short, factual sentences describing the document, to be edited later by a person. Include the strongest identifiers you found (e.g. drawing number + sheet title + revision; or for a letter / report: subject, sender, date). Do not just repeat the docType as the whole note.',
    `- detectedAddress: the street address or project / site location THIS document relates to, usually in the title block (bottom-right of a drawing) or the document header. Return it as written. If you cannot find one, return an empty string. This is independent of the document type — fill it in even when docType is ${NONE}.`,
    '- detectedJobCode: a short job / project code for this document if one is present — typically 2-4 letters or digits (format examples: GV, SH, CDL), often in the title block, as a prefix of the drawing number, or in the filename. Return it as written. If there is no clear short code, return an empty string — do NOT invent one.',
  ];

  if (examples.length) {
    lines.push(
      '',
      'For guidance, here is how this user has previously classified similar documents. Match these labelling conventions when the current document is similar. They are examples of past choices, not candidate types:',
      ...examples.map((e) => `- "${e.snippet}" -> ${e.docType}`)
    );
  }

  lines.push(
    '',
    'Candidate document types:',
    list,
    '',
    `Filename: ${filename || '(none)'}`,
    '',
    'Extracted text (may be truncated; may be empty for scanned drawings):',
    '"""',
    text || '(no extractable text)',
    '"""'
  );

  return lines.join('\n');
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
      detectedAddress: { type: 'STRING' },
      detectedJobCode: { type: 'STRING' },
    },
    required: ['docType', 'confidence', 'note', 'detectedAddress', 'detectedJobCode'],
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
