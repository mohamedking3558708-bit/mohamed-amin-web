function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Origin not allowed.' }, 403);
  if (!env.ADMIN_UPLOAD_PASSWORD) return json({ error: 'Admin password secret is not configured.' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  if (typeof body.password !== 'string' || body.password !== env.ADMIN_UPLOAD_PASSWORD) {
    return json({ error: 'Invalid password.' }, 401);
  }
  return json({ ok: true });
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Allow': 'POST, OPTIONS' } });
  }
  if (context.request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { 'Allow': 'POST, OPTIONS' } });
  return onRequestPost(context);
}
