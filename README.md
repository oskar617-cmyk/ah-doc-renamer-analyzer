# AH Doc Renamer — analyzer Worker

The AI brain for the **AH Doc Renamer** PWA. A small Cloudflare Worker that proxies
Google Gemini to classify one Auzzie Homes construction document (PDF / image) into
one of a list of candidate types, and to draft a short note describing it.

It judges the **content** — extracted text plus the first-page image — not the
filename. For drawings it is instructed to read the **title block** (bottom-right of
the sheet) for the sheet name, drawing number, discipline, revision, and the project
address / job code. It can also take **few-shot examples** of the user's past
classifications to match their labelling conventions.

Sibling of the AH Est Email Classifier Worker; same shape (Cloudflare Worker proxying
Gemini, native Workers format, auto-deployed from its GitHub repo).

- **Repo:** `oskar617-cmyk/ah-doc-renamer-analyzer`
- **Version:** `v0.07` (the `VERSION` constant at the top of `worker.js`; bump on every release)
- **Cloudflare Worker:** `ah-doc-renamer-worker-analyzer` (renamed in place; repository name unchanged)
- **Worker URL:** `https://ah-doc-renamer-worker-analyzer.oskar617.workers.dev`
- **Model:** `gemini-3.1-flash-lite` (multimodal). Set in `analyzer.js`.
  Actual price/quota depends on the key/account; rate limiting is not a spending cap.

## Contract (kept in sync with the PWA's `js/classify.js`)

**Request** — `POST`, `application/json`, with `Authorization: Bearer <API access token>`:

```json
{
  "filename": "scan001.pdf",
  "text": "…extracted text, up to ~6000 chars…",
  "image": "data:image/png;base64,…first page render…",
  "docTypes": [
    { "docType": "Architectural Plan", "sectionNumber": "A-100", "note": "floor plans, elevations, sections" },
    { "docType": "Structural Plan", "sectionNumber": "S-100", "note": "footings, framing, steel" }
  ],
  "examples": [
    { "snippet": "Ground floor plan A-101 …", "docType": "Architectural Plan" }
  ]
}
```

`image` may be `null`. `docTypes` may be empty (then the result is always "no match",
but a `note` is still drafted). `examples` is **optional** (may be empty or absent): a
few-shot list of how the user labelled similar documents before, used to bias the
classification toward their conventions.

**Response** — `application/json`:

```json
{
  "docType": "Architectural Plan",
  "sectionNumber": "A-100",
  "confidence": "high",
  "note": "Ground floor plan, drawing A-101, Rev C.",
  "detectedAddress": "12 Smith Street, Geelong VIC 3220",
  "detectedJobCode": "GV"
}
```

- `docType` is **exactly one** of the supplied `docTypes`, or `""` if none fit.
- `sectionNumber` is looked up from the matched type by the Worker (the model is
  never trusted to copy it), or `""` when there is no match.
- `confidence` is one of `high` / `medium` / `low`.
- `detectedAddress` is the address / site read from the content (especially the title
  block), or `""` if none found. Independent of `docType` — returned even on no match.
- `detectedJobCode` is a short job code (e.g. `GV` / `SH` / `CDL`) read from the
  content, or `""` if none found. The model is told not to invent one.
- Errors use `{ "error": "safe human-readable message" }`: 400 malformed input,
  401 missing/invalid API token, 403 origin/access denied, 413 body too large,
  415 wrong content type, 429 throttled (`Retry-After: 60`), 502 AI failure,
  503 unavailable protection/configuration. AI failures also retain an empty
  classification shape. All responses are `no-store`; AI requests are never retried.

## Authentication And Limits

- One existing Entra registration: `3302edd3-505b-496d-ab66-707fa7a2d827`.
  Exposes `api://3302edd3-505b-496d-ab66-707fa7a2d827/Analyzer.Invoke`, admin-only
  consent, preauthorized only for that same client, `requestedAccessTokenVersion: 2`.
- Verify Microsoft's RS256 signature/JWKS, exact tenant/issuer/audience/azp,
  delegated scope, oid/sub and token lifetime. Graph and ID tokens are rejected.
- IP limiter runs before authentication; user limiter uses verified tenant + oid.
  OBO exchanges the API token for the existing delegated Graph permissions, never
  app-only access. `/me` must match oid. Verified admin UPN retains its existing
  shortcut; every other user is checked against the existing access JSON with an
  eTag consistency check, no authorization cache and no writes. Reserved identities
  are refused. No Graph bearer is sent to the file download host or AI provider.
- Original path remains `AH Apps Docs/AH Doc Renamer/allowed-users.json` in AH Site.
  Missing/changed/unreadable file fails closed; no folder/file is created.
- `ANALYZER_IP_LIMITER`: 240 requests / 60 seconds;
  `ANALYZER_USER_LIMITER`: 60 requests / 60 seconds. These are approximate per-CF-
  location protections, **not global hard quotas or billing controls**.
- At most 8 MiB JSON (actual stream bytes), 500 distinct types, 40 examples, PNG/
  JPEG/WebP base64 images only. Auth/access lookup has a 12-second deadline;
  Gemini has a 20-second full-response deadline. Provider errors, tokens, secrets,
  download URLs and document contents are not logged or reflected to clients.

## Secrets (set in Cloudflare, never in this repo)

| Name | Value |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio (Gemini Developer API) key |
| `ENTRA_CLIENT_SECRET` | Existing App's `ah-doc-renamer-analyzer-obo` delegated OBO credential; local copy only in `~/.claude/secrets/` |
| `CORS_ORIGINS` | `https://ah-doc-renamer.pages.dev,https://oskar617-cmyk.github.io`(github.io 已关停,CORS 清理待批) |

`CORS_ORIGINS` is a comma-separated list of allowed browser origins. Other origins
are rejected. Requests without Origin still require the exact same token/access/
rate checks. CORS is not an authentication mechanism. Preflight allows Authorization.

## Deploy

Cloudflare reads `wrangler.toml` at the repo root, recognises this as a Worker, and
redeploys automatically on every push to main. Wrangler bundles the native modules
and the pinned server-only `jose` dependency (MIT, https://github.com/panva/jose).
The PWA gains no runtime dependency. Do not deploy uncommitted changes.

For this security release: prepare Entra/secret first, deploy the protected Worker,
then the matching PWA. Old pages must refresh/re-sign-in; do not preserve an anonymous
compatibility path. A rollback must retain authentication and throttling.

## Test

- `npm test` uses locally signed RSA tokens and mocked JWKS/OBO/Graph/Gemini:
  valid classification, forged/wrong-resource/expired tokens, access denials,
  dependency failures, both limiters, selftest, payload bounds and redacted failures.
- `npx wrangler deploy --dry-run` verifies the bundle and rate-limit bindings without deploying.

- `GET` the Worker URL in a browser — liveness plus which secrets are wired (no
  values shown):
  `{"ok":true,"service":"ah-doc-renamer-worker-analyzer","version":"v0.07","model":"gemini-3.1-flash-lite","configured":{"geminiKey":true,"corsOrigins":true}}`.
- `GET /?selftest=1` requires the same authenticated/authorized/limited API access as
  classification and makes ONE synthetic Gemini call. Anonymous requests return 401.
- `POST` a sample body (see Contract) — should return a valid response object whose
  `docType` is one of the supplied types or `""`.
- From the PWA origin, a real classify call should succeed with no CORS error.

## Notes

- Model changes are a separate product decision; this security release does not
  change the Gemini model, prompt, document folders or preview-only behavior.
- Credential renewal must happen before expiry. Replace the server secret through
  the authorized credential workflow; never copy it into code or browser storage.
