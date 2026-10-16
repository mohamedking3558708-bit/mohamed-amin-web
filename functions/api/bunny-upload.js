const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function cleanHostname(value) {
  let host = String(value || '').trim().replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.') || host.startsWith('.') || host.endsWith('.')) return '';
  return host;
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: 'Origin not allowed.' }, 403);
  if (!env.ADMIN_UPLOAD_PASSWORD) return json({ error: 'Secret ADMIN_UPLOAD_PASSWORD is not configured.' }, 503);
  if (request.headers.get('X-Admin-Password') !== env.ADMIN_UPLOAD_PASSWORD) return json({ error: 'Authentication required.' }, 401);

  const libraryId = String(env.BUNNY_STREAM_LIBRARY_ID || '').trim();
  const apiKey = String(env.BUNNY_STREAM_API_KEY || '').trim();
  const cdnHost = cleanHostname(env.BUNNY_CDN_HOSTNAME);
  if (!/^\d+$/.test(libraryId) || !apiKey || !cdnHost) {
    return json({ error: 'Bunny Stream is not configured. Check BUNNY_STREAM_LIBRARY_ID, BUNNY_STREAM_API_KEY and BUNNY_CDN_HOSTNAME in Cloudflare.' }, 503);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON request.' }, 400); }
  if (body?.action !== 'create') return json({ error: 'Unknown action.' }, 400);

  const title = String(body.title || body.filename || 'Portfolio video').trim().slice(0, 180) || 'Portfolio video';
  const filename = String(body.filename || '').slice(0, 255);
  const reportedSize = Number(body.size || 0);
  const contentType = String(body.contentType || '').trim().toLowerCase();
  if (!Number.isFinite(reportedSize) || reportedSize <= 0) return json({ error: 'Video size is missing or invalid.' }, 400);
  if (reportedSize > 5 * 1024 ** 3) return json({ error: 'Maximum video size is 5 GiB.' }, 413);
  if (!contentType.startsWith('video/')) return json({ error: 'Choose a valid video file.' }, 415);

  let created;
  try {
    const response = await fetch(`https://video.bunnycdn.com/library/${encodeURIComponent(libraryId)}/videos`, {
      method: 'POST',
      headers: {
        AccessKey: apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title }),
    });
    const text = await response.text();
    try { created = JSON.parse(text); } catch { created = {}; }
    if (!response.ok || !created.guid) {
      const detail = String(created.message || created.error || '').trim();
      return json({ error: detail ? `Bunny Stream could not create the video: ${detail}` : `Bunny Stream rejected the request (${response.status}).` }, 502);
    }
  } catch {
    return json({ error: 'Could not connect to the Bunny Stream API.' }, 502);
  }

  const guid = String(created.guid);
  const expires = Math.floor(Date.now() / 1000) + 4 * 60 * 60;
  const signature = await sha256Hex(`${libraryId}${apiKey}${expires}${guid}`);

  return json({
    ok: true,
    guid,
    libraryId,
    endpoint: 'https://video.bunnycdn.com/tusupload',
    signature,
    expires,
    mediaUrl: `/api/media/video-${guid}.mp4`,
    filename,
    uploadProtocol: 'tus',
  });
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { Allow: 'POST, OPTIONS' } });
  if (context.request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } });
  return onRequestPost(context);
}
