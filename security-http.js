// Bounded, non-logging HTTP helpers shared by auth and the AI adapter.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function readJson(response, maxBytes, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) throw new HttpError(413, 'Request is too large');
  if (!response.body) throw new HttpError(400, 'Invalid JSON body');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new HttpError(413, 'Request is too large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new HttpError(400, 'Invalid JSON body'); }
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function fetchJson(url, init, maxBytes, signal) {
  const response = await fetch(url, { ...init, signal, redirect: 'error' });
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    throw new HttpError(503, 'Upstream service is unavailable');
  }
  return readJson(response, maxBytes, signal);
}
