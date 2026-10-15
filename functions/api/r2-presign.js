const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

const encoder = new TextEncoder();
const toHex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const awsEncode = value => encodeURIComponent(value).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

async function sha256Hex(value) {
  return toHex(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value));
}

async function hmac(keyBytes, value) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

async function createPresignedPut({ endpoint, bucket, key, contentType, accessKey, secretKey }) {
  const now = new Date();
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const amzDate = iso;
  const shortDate = amzDate.slice(0, 8);
  const host = endpoint.hostname;
  const scope = `${shortDate}/auto/s3/aws4_request`;
  const canonicalUri = `/${awsEncode(bucket)}/${key.split('/').map(awsEncode).join('/')}`;
  const query = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD'],
    ['X-Amz-Credential', `${accessKey}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', '3600'],
    ['X-Amz-SignedHeaders', 'content-type;host'],
  ];
  const canonicalQuery = query.map(([k, v]) => [awsEncode(k), awsEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const canonicalRequest = ['PUT', canonicalUri, canonicalQuery, canonicalHeaders, 'content-type;host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');

  let signingKey = await hmac(encoder.encode(`AWS4${secretKey}`), shortDate);
  signingKey = await hmac(signingKey, 'auto');
  signingKey = await hmac(signingKey, 's3');
  signingKey = await hmac(signingKey, 'aws4_request');
  const signature = toHex(await hmac(signingKey, stringToSign));
  const url = new URL(`${endpoint.origin}${canonicalUri}`);
  url.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
  return url.toString();
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: 'Origin not allowed.' }, 403);
  if (!env.ADMIN_UPLOAD_PASSWORD) return json({ error: 'Upload API is not configured.' }, 503);
  if (request.headers.get('X-Admin-Password') !== env.ADMIN_UPLOAD_PASSWORD) return json({ error: 'Authentication required.' }, 401);

  for (const name of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_ENDPOINT']) {
    if (!env[name]) return json({ error: `Missing server setting: ${name}` }, 503);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  const filename = typeof body.filename === 'string' ? body.filename : '';
  const contentType = typeof body.contentType === 'string' ? body.contentType.split(';')[0].trim().toLowerCase() : '';
  const size = Number(body.size);
  const isVideo = contentType.startsWith('video/');
  const isImage = contentType.startsWith('image/');
  if ((!isVideo && !isImage) || !Number.isFinite(size) || size <= 0) {
    return json({ error: 'Choose a valid video or image file.' }, 400);
  }
  if (isVideo && size > 5 * 1024 ** 3) return json({ error: 'Single-file upload limit is 5 GiB. Use a smaller video.' }, 413);
  if (isImage && size > 25 * 1024 ** 2) return json({ error: 'Thumbnail image limit is 25 MiB.' }, 413);

  let endpoint;
  try {
    endpoint = new URL(env.R2_ENDPOINT);
    if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/' && endpoint.pathname !== '' || endpoint.search || endpoint.hash || !endpoint.hostname.endsWith('.r2.cloudflarestorage.com')) {
      throw new Error('Invalid endpoint');
    }
  } catch {
    return json({ error: 'R2_ENDPOINT must be the full account endpoint, e.g. https://ACCOUNT_ID.r2.cloudflarestorage.com' }, 503);
  }

  const sourceExt = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  const extFromType = ({ 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/ogg': 'ogv', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' })[contentType];
  const ext = /^[a-z0-9]{1,8}$/.test(sourceExt) ? sourceExt : (extFromType || (isVideo ? 'mp4' : 'png'));
  const key = `${isVideo ? 'video' : 'image'}-${crypto.randomUUID()}.${ext}`;

  try {
    const uploadUrl = await createPresignedPut({
      endpoint,
      bucket: env.R2_BUCKET_NAME,
      key,
      contentType,
      accessKey: env.R2_ACCESS_KEY_ID,
      secretKey: env.R2_SECRET_ACCESS_KEY,
    });
    return json({ uploadUrl, key, mediaUrl: `/api/media/${encodeURIComponent(key)}`, contentType, expiresIn: 3600 });
  } catch {
    return json({ error: 'Could not create the temporary upload URL. Check the R2 credentials and endpoint.' }, 500);
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Allow': 'POST, OPTIONS' } });
  if (context.request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { 'Allow': 'POST, OPTIONS' } });
  return onRequestPost(context);
}
