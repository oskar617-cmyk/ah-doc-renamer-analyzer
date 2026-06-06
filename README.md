# AH Doc Renamer — analyzer Worker

The AI brain for the **AH Doc Renamer** PWA. A small Cloudflare Worker that proxies
Google Gemini to classify one Auzzie Homes construction document (PDF / image) into
one of a list of candidate types, and to draft a short note describing it.

It judges the **content** — extracted text plus the first-page image — not the
filename. For drawings it is instructed to read the **title block** (bottom-right of
the sheet) for the sheet name, drawing number, discipline and revision.

Sibling of the AH Est Email Classifier Worker; same shape (Cloudflare Worker proxying
Gemini, native Workers format, auto-deployed from its GitHub repo).

- **Repo:** `oskar617-cmyk/ah-doc-renamer-analyzer`
- **Version:** `v0.02` (the `VERSION` constant at the top of `worker.js`; bump on every release)
- **Worker URL (after deploy):** `https://ah-doc-renamer-analyzer.oskar617.workers.dev`
- **Model:** `gemini-3.1-flash-lite` (free tier, multimodal). Set in the `MODEL`
  constant at the top of `worker.js`.

## Contract (must match the PWA's `js/classify.js` — do not change)

**Request** — `POST`, `application/json`:

```json
{
  "filename": "scan001.pdf",
  "text": "…extracted text, up to ~6000 chars…",
  "image": "data:image/png;base64,…first page render…",
  "docTypes": [
    { "docType": "Architectural Plan", "sectionNumber": "A-100", "note": "floor plans, elevations, sections" },
    { "docType": "Structural Plan", "sectionNumber": "S-100", "note": "footings, framing, steel" }
  ]
}
```

`image` may be `null`. `docTypes` may be empty (then the result is always "no match",
but a `note` is still drafted).

**Response** — `application/json`:

```json
{
  "docType": "Architectural Plan",
  "sectionNumber": "A-100",
  "confidence": "high",
  "note": "Ground floor plan, drawing A-101, Rev C."
}
```

- `docType` is **exactly one** of the supplied `docTypes`, or `""` if none fit.
- `sectionNumber` is looked up from the matched type by the Worker (the model is
  never trusted to copy it), or `""` when there is no match.
- `confidence` is one of `high` / `medium` / `low`.
- On any internal failure the Worker still returns this exact shape with empty values
  (`docType: ""`, `confidence: "low"`) plus an `error` field, so the PWA never crashes.
  Genuinely malformed requests return HTTP `400`.

## Secrets (set in Cloudflare, never in this repo)

| Name | Value |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio (Gemini Developer API) key |
| `CORS_ORIGINS` | `https://ah-doc-renamer.pages.dev,https://oskar617-cmyk.github.io` |

`CORS_ORIGINS` is a comma-separated list of allowed browser origins. Browser calls
from any other origin are rejected (this protects the Gemini quota). Calls with no
`Origin` header (curl / server-to-server) are allowed.

## Deploy

Cloudflare reads `wrangler.toml` at the repo root, recognises this as a Worker, and
redeploys automatically on every push to the connected GitHub repo. No build step,
no npm dependencies.

## Test

- `GET` the Worker URL in a browser — liveness plus which secrets are wired (no
  values shown):
  `{"ok":true,"service":"ah-doc-renamer-analyzer","version":"v0.02","model":"gemini-3.1-flash-lite","configured":{"geminiKey":true,"corsOrigins":true}}`.
- `GET /?selftest=1` — makes ONE real Gemini call and returns `"geminiOk":true` with
  a sample classification when the key is valid and the model name is correct. This is
  the quickest way to confirm the whole pipeline works. Note: it spends one (tiny)
  Gemini request each time it is hit; remove the `selftest` block if you do not want a
  public endpoint that calls Gemini.
- `POST` a sample body (see Contract) — should return a valid response object whose
  `docType` is one of the supplied types or `""`.
- From the PWA origin, a real classify call should succeed with no CORS error.

## Notes

- To upgrade to `gemini-3.5-flash` later (paid tier; marginally stronger on messy
  title blocks) change only the `MODEL` constant in `worker.js`.
- If responses ever come back empty with a `MAX_TOKENS` reason in the logs, raise
  `maxOutputTokens` in `worker.js`.
