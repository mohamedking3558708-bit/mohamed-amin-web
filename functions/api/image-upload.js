const OWNER = 'mohamedking3558708-bit';
const REPO = 'mohamed-amin-web';
const BRANCH = 'main';
const MAX_IMAGE = 8 * 1024 * 1024;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

function base64FromBytes(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function ghHeaders(env, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mohamed-amin-portfolio-admin',
    ...extra,
  };
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: 'Origin not allowed.' }, 403);
  if (!env.ADMIN_UPLOAD_PASSWORD) return json({ error: 'Secret ADMIN_UPLOAD_PASSWORD is not configured.' }, 503);
  if (request.headers.get('X-Admin-Password') !== env.ADMIN_UPLOAD_PASSWORD) return json({ error: 'Authentication required.' }, 401);
  if (!env.GITHUB_TOKEN) return json({ error: 'Secret GITHUB_TOKEN is not configured in Cloudflare.' }, 503);

  let form;
  try { form = await request.formData(); } catch { return json({ error: 'Could not read the uploaded image.' }, 400); }
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') return json({ error: 'Choose an image file.' }, 400);
  if (file.size <= 0 || file.size > MAX_IMAGE) return json({ error: 'Image size must be between 1 byte and 8 MiB.' }, 413);

  const type = String(file.type || '').split(';')[0].trim().toLowerCase();
  const extByType = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
  };
  const ext = extByType[type];
  if (!ext) return json({ error: 'Supported images: JPG, PNG, WebP, GIF or AVIF. SVG is not accepted.' }, 415);

  const owner = String(env.GITHUB_OWNER || OWNER).trim();
  const repo = String(env.GITHUB_REPO || REPO).trim();
  const branch = String(env.GITHUB_BRANCH || BRANCH).trim();
  const key = `image-${crypto.randomUUID()}.${ext}`;
  const repoPath = `uploads/images/${key}`;

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${repoPath}`, {
      method: 'PUT',
      headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        message: `Upload portfolio image ${key}`,
        content: base64FromBytes(bytes),
        branch,
      }),
    });
    let result = {};
    try { result = await response.json(); } catch {}
    if (!response.ok) {
      const detail = result?.message ? ` ${result.message}` : '';
      return json({ error: `GitHub could not save the image (${response.status}).${detail}` }, 502);
    }
    const branchPath = branch.split('/').map(encodeURIComponent).join('/');
    const mediaUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${branchPath}/${repoPath}`;
    return json({ ok: true, key, mediaUrl, size: file.size, contentType: type });
  } catch {
    return json({ error: 'Could not upload the image to the GitHub repository.' }, 502);
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { Allow: 'POST, OPTIONS' } });
  if (context.request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } });
  return onRequestPost(context);
}
