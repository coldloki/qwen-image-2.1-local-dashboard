// Thin fetch wrappers. All return parsed JSON or throw.
// Streams (SSE) use a separate function.

const j = (method) => async (url, body) => {
  const init = {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
  };
  if (body) init.body = JSON.stringify(body);
  const r = await fetch(url, init);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  if (r.status === 204) return null;
  return r.json();
};

export const api = {
  get:    j('GET'),
  post:   j('POST'),
  put:    j('PUT'),
  del:    j('DELETE'),
};

export async function* streamGenerate(req) {
  // SSE: fetch + ReadableStream + TextDecoder line reader.
  const r = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!r.ok || !r.body) {
    let body = null;
    try { body = await r.json(); } catch {}
    const detail = body?.detail || `HTTP ${r.status}`;
    // Attach structured fields so callers can render a friendly message
    // instead of a raw error string.
    const err = new Error(detail);
    err.status = r.status;
    err.retryAfter = Number(r.headers.get('Retry-After')) || body?.retry_after || null;
    err.payload = body;
    throw err;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload) yield JSON.parse(payload);
        }
      }
    }
  }
}
