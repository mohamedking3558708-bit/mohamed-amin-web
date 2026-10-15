const MAX_EDGE_CACHE_BYTES = 30 * 1024 * 1024;
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

function errorResponse(message, status = 404, headers = {}) {
  return new Response(message, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers }
  });
}

function mediaHeaders(object) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', IMMUTABLE_CACHE_CONTROL);
  headers.set('X-Content-Type-Options', 'nosniff');
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/octet-stream');
  headers.set('Content-Disposition', 'inline');
  return headers;
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return { invalid: true };

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) {
    return { invalid: true };
  }
  end = Math.min(end, size - 1);
  return { start, end, length: end - start + 1 };
}

function fullCacheKey(requestUrl) {
  const url = new URL(requestUrl);
  // Media object keys are immutable UUIDs; ignore incidental query strings for cache reuse.
  return new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
}

function partialCacheKey(requestUrl, range) {
  const url = new URL(requestUrl);
  url.search = '';
  url.searchParams.set('__r2_range_cache', `${range.start}-${range.end}`);
  return new Request(url.toString(), { method: 'GET' });
}

function scheduleCacheWrite(context, cache, key, response) {
  if (!cache || response.status !== 200) return;
  const write = cache.put(key, response).catch(() => {});
  if (typeof context.waitUntil === 'function') context.waitUntil(write);
  else write.catch(() => {});
}

export async function onRequest(context) {
  const { request, env, params } = context;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse('Method not allowed', 405, { Allow: 'GET, HEAD' });
  }
  if (!env.PORTFOLIO_R2) {
    return errorResponse('R2 bucket binding PORTFOLIO_R2 is not configured.', 503);
  }

  const key = String(params.key || '');
  if (!/^(?:video|image)-[0-9a-f-]{36}\.[a-z0-9]{1,8}$/i.test(key)) {
    return errorResponse('Not found', 404);
  }

  let cache = null;
  try { cache = caches.default; } catch (error) {}
  const wholeKey = fullCacheKey(request.url);
  const rangeHeader = request.headers.get('Range');
  let wholeCached = null;
  if (cache && request.method === 'GET') {
    try { wholeCached = await cache.match(wholeKey); } catch (error) {}
  }

  // A regular GET can be served without touching R2 after the first successful cache fill.
  if (request.method === 'GET' && !rangeHeader && wholeCached) return wholeCached;
  if (request.method === 'HEAD' && wholeCached) {
    return new Response(null, { status: 200, headers: wholeCached.headers });
  }

  if (request.method === 'HEAD') {
    const head = await env.PORTFOLIO_R2.head(key);
    if (!head) return errorResponse('Not found', 404);
    const headers = mediaHeaders(head);
    headers.set('Content-Length', String(head.size));
    return new Response(null, { status: 200, headers });
  }

  if (!rangeHeader) {
    // Avoid the old HEAD + GET double request for normal media downloads.
    const object = await env.PORTFOLIO_R2.get(key);
    if (!object) return errorResponse('Not found', 404);
    const headers = mediaHeaders(object);
    headers.set('Content-Length', String(object.size));
    const response = new Response(object.body, { status: 200, headers });
    if (cache && object.size <= MAX_EDGE_CACHE_BYTES) {
      scheduleCacheWrite(context, cache, wholeKey, response.clone());
    }
    return response;
  }

  // Range requests are handled separately so a 206 response is never mistakenly cached as a full file.
  let head = null;
  let size = 0;
  if (wholeCached) {
    size = Number(wholeCached.headers.get('Content-Length')) || 0;
  } else {
    head = await env.PORTFOLIO_R2.head(key);
    if (!head) return errorResponse('Not found', 404);
    size = head.size;
  }

  const range = parseRange(rangeHeader, size);
  if (range?.invalid) {
    return errorResponse('Requested range is not satisfiable.', 416, {
      'Content-Range': `bytes */${size}`,
      'Accept-Ranges': 'bytes'
    });
  }
  if (!range) return errorResponse('Invalid range.', 416, { 'Content-Range': `bytes */${size}` });

  const partialKey = partialCacheKey(request.url, range);
  if (cache && range.length <= MAX_EDGE_CACHE_BYTES) {
    try {
      const cachedPartial = await cache.match(partialKey);
      if (cachedPartial) {
        const headers = new Headers(cachedPartial.headers);
        headers.set('Content-Length', String(range.length));
        headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
        headers.set('Accept-Ranges', 'bytes');
        return new Response(cachedPartial.body, { status: 206, headers });
      }
    } catch (error) {}
  }

  // If a complete small file is already cached, satisfy the byte-range request from it.
  if (wholeCached && size <= MAX_EDGE_CACHE_BYTES) {
    const bytes = await wholeCached.arrayBuffer();
    const slice = bytes.slice(range.start, range.end + 1);
    const headers = new Headers(wholeCached.headers);
    headers.set('Content-Length', String(range.length));
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    headers.set('Accept-Ranges', 'bytes');
    return new Response(slice, { status: 206, headers });
  }

  const object = await env.PORTFOLIO_R2.get(key, { range: { offset: range.start, length: range.length } });
  if (!object) return errorResponse('Not found', 404);
  const headers = mediaHeaders(head || object);
  headers.set('Content-Length', String(range.length));
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
  const partialResponse = new Response(object.body, { status: 206, headers });

  // Store each requested small range under a synthetic cache key with status 200,
  // then reconstruct a correct 206 response on cache hit. This avoids caching a 206 directly.
  if (cache && range.length <= MAX_EDGE_CACHE_BYTES) {
    const storedHeaders = new Headers(headers);
    storedHeaders.delete('Content-Range');
    const storedResponse = new Response(partialResponse.clone().body, { status: 200, headers: storedHeaders });
    scheduleCacheWrite(context, cache, partialKey, storedResponse);
  }
  return partialResponse;
}
