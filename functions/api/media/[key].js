// Serves uploaded media from R2.
//
// Why videos used to "re-download on every loop" and feel like a slow connection:
//  - The response had NO validator (no ETag / Last-Modified). Chrome/Safari only keep and reuse partial (206)
//    video data in their HTTP cache when the response has a validator, so on every loop / seek they went back to the network.
//  - Now every response carries a strong ETag + "immutable" caching, and conditional requests are answered with 304
//    without touching R2 at all.
//
// Keys are random UUIDs that are never overwritten (see r2-presign.js), so the key itself is a perfect ETag.

const EDGE_CACHE_MAX_BYTES = 30 * 1024 * 1024;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const EDGE_CACHE_VERSION = 'v2'; // bump = ignore older edge-cache entries that were stored without an ETag
const KEY_RE = /^(?:video|image)-[0-9a-f-]{36}\.[a-z0-9]{1,8}$/i;

function response(message, status = 404, headers = {}) {
  return new Response(message, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

const etagFor = key => `"${key}"`;

function matchesEtag(headerValue, etag) {
  if (!headerValue) return false;
  return headerValue.split(',').some(token => {
    const t = token.trim();
    return t === '*' || t === etag || t === `W/${etag}`;
  });
}

function baseHeaders(object, etag) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', CACHE_CONTROL);
  headers.set('ETag', etag);
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

// Make sure anything served from the edge cache also carries the validator + caching headers.
function withValidators(res, etag) {
  if (res.headers.get('ETag') === etag && res.headers.get('Cache-Control') === CACHE_CONTROL) return res;
  const headers = new Headers(res.headers);
  headers.set('ETag', etag);
  headers.set('Cache-Control', CACHE_CONTROL);
  headers.set('Accept-Ranges', 'bytes');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export async function onRequest({ request, env, params, waitUntil }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return response('Method not allowed', 405, { Allow: 'GET, HEAD' });
  }
  if (!env.PORTFOLIO_R2) return response('R2 bucket binding PORTFOLIO_R2 is not configured.', 503);
  const key = String(params.key || '');
  if (!KEY_RE.test(key)) return response('Not found', 404);

  const etag = etagFor(key);

  // 0) The browser already has this exact file: answer 304 immediately, no R2 / cache work.
  if (matchesEtag(request.headers.get('If-None-Match'), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': CACHE_CONTROL } });
  }

  const cache = caches.default;
  const url = new URL(request.url);
  const cacheKey = new Request(`${url.origin}${url.pathname}?edge=${EDGE_CACHE_VERSION}`, { method: 'GET' });

  let rangeHeader = request.headers.get('Range');
  // If-Range with a different validator means "the file changed": send the whole file instead of a range.
  const ifRange = request.headers.get('If-Range');
  if (rangeHeader && ifRange && ifRange !== etag) rangeHeader = null;

  // 1) Edge cache hit (also answers Range requests with 206).
  if (request.method === 'GET') {
    const hit = await cache.match(rangeHeader ? new Request(cacheKey, { headers: { Range: rangeHeader } }) : cacheKey);
    if (hit) return withValidators(hit, etag);
  }

  // 2) Miss: read from R2.
  const head = await env.PORTFOLIO_R2.head(key);
  if (!head) return response('Not found', 404);
  const headers = baseHeaders(head, etag);
  headers.set('Content-Length', String(head.size));
  headers.set('X-Media-Source', 'r2');
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });

  // Fill the edge cache once (only from the first request of a file: no Range, or "bytes=0-").
  const canCache = head.size <= EDGE_CACHE_MAX_BYTES && (!rangeHeader || /^bytes=0-/.test(rangeHeader.trim()));
  const range = parseRange(rangeHeader, head.size);
  if (range?.invalid) return response('Requested range is not satisfiable.', 416, { 'Content-Range': `bytes */${head.size}`, 'Accept-Ranges': 'bytes' });

  if (!range) {
    const object = await env.PORTFOLIO_R2.get(key);
    if (!object) return response('Not found', 404);
    const outHeaders = baseHeaders(object, etag);
    outHeaders.set('Content-Length', String(object.size));
    outHeaders.set('X-Media-Source', 'r2');
    if (canCache && waitUntil) {
      const [forClient, forCache] = object.body.tee();
      waitUntil(cache.put(cacheKey, new Response(forCache, { status: 200, headers: outHeaders })));
      return new Response(forClient, { status: 200, headers: outHeaders });
    }
    return new Response(object.body, { status: 200, headers: outHeaders });
  }

  if (canCache && waitUntil) {
    waitUntil((async () => {
      const full = await env.PORTFOLIO_R2.get(key);
      if (!full) return;
      const fullHeaders = baseHeaders(full, etag);
      fullHeaders.set('Content-Length', String(full.size));
      await cache.put(cacheKey, new Response(full.body, { status: 200, headers: fullHeaders }));
    })());
  }
  const object = await env.PORTFOLIO_R2.get(key, { range: { offset: range.start, length: range.length } });
  if (!object) return response('Not found', 404);
  const outHeaders = baseHeaders(object, etag);
  outHeaders.set('Content-Length', String(range.length));
  outHeaders.set('Content-Range', `bytes ${range.start}-${range.end}/${head.size}`);
  outHeaders.set('X-Media-Source', 'r2');
  return new Response(object.body, { status: 206, headers: outHeaders });
}
