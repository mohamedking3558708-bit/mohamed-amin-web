function response(message, status = 404) {
  return new Response(message, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function cleanHostname(value) {
  const host = String(value || '').trim().replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  return /^[a-z0-9.-]+$/.test(host) && host.includes('.') && !host.startsWith('.') && !host.endsWith('.') ? host : '';
}

export async function onRequest({ request, env, params }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return response('Method not allowed', 405);

  // New video URLs are UUID-based aliases that redirect to Bunny Stream's MP4 fallback.
  const key = String(params.key || '');
  const match = /^video-([0-9a-f-]{36})\.[a-z0-9]{1,8}$/i.exec(key);
  if (!match) {
    return response('This media file is not hosted here anymore. Re-upload the image from the admin panel.', 410);
  }

  const host = cleanHostname(env.BUNNY_CDN_HOSTNAME);
  if (!host) return response('BUNNY_CDN_HOSTNAME is not configured.', 503);

  const guid = match[1];
  const target = `https://${host}/${guid}/play_720p.mp4`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: target,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
}
