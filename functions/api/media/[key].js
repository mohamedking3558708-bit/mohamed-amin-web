// Serves uploaded media from R2.
// - Small files are kept in Cloudflare's edge cache after the first view, so later plays / loops / seeks never touch R2.
// - Range requests are always answered with a proper 206, so the browser can seek and keep buffering smoothly.

const EDGE_CACHE_MAX_BYTES = 30 * 1024 * 1024;

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

  const cache = caches.default;
  const url = new URL(request.url);
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
  const rangeHeader = request.headers.get('Range');

  // 1) Edge cache hit: answered by Cloudflare itself (including Range requests -> 206).
  if (request.method === 'GET') {
    const hit = await cache.match(rangeHeader ? new Request(cacheKey, { headers: { Range: rangeHeader } }) : cacheKey);
    if (hit) return hit;
  }

  // 2) Miss: read from R2.
  const head = await env.PORTFOLIO_R2.head(key);
  if (!head) return response('Not found', 404);
  const headers = baseHeaders(head);
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
    const outHeaders = baseHeaders(object);
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
      const fullHeaders = baseHeaders(full);
      fullHeaders.set('Content-Length', String(full.size));
      await cache.put(cacheKey, new Response(full.body, { status: 200, headers: fullHeaders }));
    })());
  }
  const object = await env.PORTFOLIO_R2.get(key, { range: { offset: range.start, length: range.length } });
  if (!object) return response('Not found', 404);
  const outHeaders = baseHeaders(object);
  outHeaders.set('Content-Length', String(range.length));
  outHeaders.set('Content-Range', `bytes ${range.start}-${range.end}/${head.size}`);
  outHeaders.set('X-Media-Source', 'r2');
  return new Response(object.body, { status: 206, headers: outHeaders });
}
