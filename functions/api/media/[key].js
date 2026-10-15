// Serves uploaded media from R2 and caches small files at the Cloudflare edge,
// so repeat views (and range requests) are answered without waking R2 each time.

const EDGE_CACHE_MAX_BYTES = 30 * 1024 * 1024; // larger files are streamed straight from R2 with Range support

function response(message, status = 404, headers = {}) {
  return new Response(message, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function baseHeaders(object) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/octet-stream');
  headers.set('Content-Disposition', 'inline');
  return headers;
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return { invalid: true };
  let start, end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) return { invalid: true };
  end = Math.min(end, size - 1);
  return { start, end, length: end - start + 1 };
}

export async function onRequest({ request, env, params, waitUntil }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return response('Method not allowed', 405, { Allow: 'GET, HEAD' });
  }
  if (!env.PORTFOLIO_R2) return response('R2 bucket binding PORTFOLIO_R2 is not configured.', 503);
  const key = String(params.key || '');
  if (!/^(?:video|image)-[0-9a-f-]{36}\.[a-z0-9]{1,8}$/i.test(key)) return response('Not found', 404);

  // Edge cache: one entry per file (the key is a UUID, so it never changes). The cache answers Range requests itself.
  const cache = caches.default;
  const url = new URL(request.url);
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
  const rangeHeader = request.headers.get('Range');
  if (request.method === 'GET') {
    const lookup = rangeHeader ? new Request(cacheKey, { headers: { Range: rangeHeader } }) : cacheKey;
    const hit = await cache.match(lookup);
    if (hit) return hit;
  }

  const head = await env.PORTFOLIO_R2.head(key);
  if (!head) return response('Not found', 404);
  const headers = baseHeaders(head);
  headers.set('Content-Length', String(head.size));
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });

  // Small file, first visit: read it once, store it at the edge, answer with the full file.
  if (head.size <= EDGE_CACHE_MAX_BYTES) {
    const object = await env.PORTFOLIO_R2.get(key);
    if (!object) return response('Not found', 404);
    const outHeaders = baseHeaders(object);
    outHeaders.set('Content-Length', String(object.size));
    const full = new Response(object.body, { status: 200, headers: outHeaders });
    if (waitUntil) waitUntil(cache.put(cacheKey, full.clone()));
    return full;
  }

  // Large file: stream from R2 with Range support (no edge caching).
  const range = parseRange(rangeHeader, head.size);
  if (range?.invalid) return response('Requested range is not satisfiable.', 416, { 'Content-Range': `bytes */${head.size}`, 'Accept-Ranges': 'bytes' });
  if (!range) {
    const object = await env.PORTFOLIO_R2.get(key);
    if (!object) return response('Not found', 404);
    const outHeaders = baseHeaders(object);
    outHeaders.set('Content-Length', String(object.size));
    return new Response(object.body, { status: 200, headers: outHeaders });
  }
  const object = await env.PORTFOLIO_R2.get(key, { range: { offset: range.start, length: range.length } });
  if (!object) return response('Not found', 404);
  const outHeaders = baseHeaders(object);
  outHeaders.set('Content-Length', String(range.length));
  outHeaders.set('Content-Range', `bytes ${range.start}-${range.end}/${head.size}`);
  return new Response(object.body, { status: 206, headers: outHeaders });
}
