import {createDirectClient} from './vendor/vaenyx/direct.mjs';

export const MODEL = 'gemini-3.1-flash-lite';
const NONE = '__NONE__';

export async function classify({ apiKey, filename, text, image, candidates, examples = [] }) {
  const prompt = buildPrompt({ filename, text, candidates, examples });
  const schema = buildSchema(candidates);

  const img=image?parseDataUrl(image):null;
  const result=await createDirectClient({provider:'gemini',apiKey,timeoutMs:20000}).run({model:MODEL,prompt,capability:'structured_output',requirements:{max_output_tokens:8192,schema}}, {attachments:img?[{name:'document.png',mime:img.mimeType,base64:img.data}]:[]});
  const out=result.text;

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
    type: 'object',
    properties: {
      docType: { type: 'string', enum: docTypeEnum },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      note: { type: 'string' },
      detectedAddress: { type: 'string' },
      detectedJobCode: { type: 'string' },
    },
    required: ['docType', 'confidence', 'note', 'detectedAddress', 'detectedJobCode'],
  };
}

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
