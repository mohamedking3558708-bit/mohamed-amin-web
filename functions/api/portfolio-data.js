// Admin-only endpoint: reads and writes portfolio-data.json in the GitHub repo.
// The GitHub token never reaches the browser: it lives in the Cloudflare secret GITHUB_TOKEN.
// Auth is the same admin password already used by /api/admin-auth and /api/r2-presign.

const OWNER = 'mazen1-1';
const REPO = 'mohamed-amin-1';
const BRANCH = 'main';
const FILE_PATH = 'portfolio-data.json';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function passwordMatches(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

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

function bytesFromBase64(value) {
  const binary = atob(String(value || '').replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------- GitHub ----------
function ghUrl(env, path) {
  const owner = env.GITHUB_OWNER || OWNER;
  const repo = env.GITHUB_REPO || REPO;
  return `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
}

function ghHeaders(env, extra = {}) {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mohamed-amin-portfolio-admin',
    ...extra,
  };
}

function ghError(response, fallback) {
  if (response.status === 401) return 'سر GITHUB_TOKEN في Cloudflare غير صالح أو منتهي.';
  if (response.status === 403) return 'سر GITHUB_TOKEN لا يملك صلاحية كافية (يلزم Contents: Read and write) أو تم تجاوز الحد.';
  if (response.status === 404) return 'تعذر الوصول إلى المستودع من خلال GITHUB_TOKEN. تأكد من صلاحية الوصول للمستودع.';
  return `${fallback} (${response.status})`;
}

async function readFile(env) {
  const branch = env.GITHUB_BRANCH || BRANCH;
  const response = await fetch(`${ghUrl(env, FILE_PATH)}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders(env) });
  if (response.status === 404) return { sha: null, data: null };
  if (!response.ok) throw Object.assign(new Error(ghError(response, 'تعذر قراءة ملف البيانات')), { status: 502 });
  const file = await response.json();
  let text;
  if (file.encoding === 'base64' && file.content) {
    text = decoder.decode(bytesFromBase64(file.content));
  } else {
    const raw = await fetch(`${ghUrl(env, FILE_PATH)}?ref=${encodeURIComponent(branch)}`, {
      headers: ghHeaders(env, { 'Accept': 'application/vnd.github.raw+json' }),
    });
    if (!raw.ok) throw Object.assign(new Error(ghError(raw, 'تعذر قراءة ملف البيانات')), { status: 502 });
    text = await raw.text();
  }
  let data;
  try { data = JSON.parse(text); } catch { throw Object.assign(new Error('ملف البيانات الحالي ليس JSON صالحًا.'), { status: 502 }); }
  return { sha: file.sha, data };
}

async function writeFile(env, data, sha) {
  const branch = env.GITHUB_BRANCH || BRANCH;
  const body = {
    message: 'Update portfolio data via admin.html',
    content: base64FromBytes(encoder.encode(JSON.stringify(data, null, 2))),
    branch,
  };
  if (sha) body.sha = sha;
  return fetch(ghUrl(env, FILE_PATH), {
    method: 'PUT',
    headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

async function saveFile(env, data) {
  let { sha } = await readFile(env);
  let response = await writeFile(env, data, sha);
  if (response.status === 409 || response.status === 422) {
    // The file changed between our read and write: re-read the SHA once and retry.
    ({ sha } = await readFile(env));
    response = await writeFile(env, data, sha);
  }
  if (!response.ok) throw Object.assign(new Error(ghError(response, 'تعذر نشر التعديلات')), { status: 502 });
}

// ---------- Validation: only device uploads (R2) are accepted, no external links ----------
const MEDIA_RE = /^\/api\/media\/(?:video|image)-[0-9a-f-]{36}\.[a-z0-9]{1,8}$/i;
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const str = (value, max = 2000) => String(value ?? '').slice(0, max);
const bool = (value, fallback = true) => (typeof value === 'boolean' ? value : fallback);
const mediaUrl = (value, label, required = false) => {
  const url = String(value ?? '').trim();
  if (!url) { if (required) fail(`${label} مطلوب.`); return ''; }
  if (!MEDIA_RE.test(url)) fail(`${label} يجب أن يكون ملفًا مرفوعًا من الجهاز (لا روابط خارجية).`);
  return url;
};

function normalize(input) {
  if (!input || typeof input !== 'object') fail('بيانات غير صالحة.');
  const list = value => (Array.isArray(value) ? value : []);

  const heroVideos = list(input.heroVideos).map((v, i) => ({
    id: str(v?.id, 80) || `hero-${i + 1}`,
    url: mediaUrl(v?.url, `فيديو الهيرو رقم ${i + 1}`, true),
    showDesktop: bool(v?.showDesktop),
    showMobile: bool(v?.showMobile),
  }));
  if (heroVideos.length > 3) fail('الحد الأقصى ثلاثة فيديوهات في الهيرو.');
  if (heroVideos.filter(v => v.showDesktop).length > 2) fail('اختر فيديوهين فقط كحد أقصى للكمبيوتر.');
  if (heroVideos.filter(v => v.showMobile).length > 3) fail('اختر ثلاثة فيديوهات كحد أقصى للهاتف.');

  const sections = list(input.sections).map((s, i) => ({
    id: str(s?.id, 80),
    title: str(s?.title, 120) || str(s?.titleAr, 120),
    titleAr: str(s?.titleAr, 120) || str(s?.title, 120),
    order: Number.isFinite(Number(s?.order)) ? Number(s.order) : i + 1,
  }));
  sections.forEach((s, i) => {
    if (!s.id || (!s.title && !s.titleAr)) fail(`القسم رقم ${i + 1} غير مكتمل.`);
  });
  const sectionIds = new Set(sections.map(s => s.id));

  const items = list(input.items).map((item, i) => {
    const n = i + 1;
    const type = item?.type === 'image' ? 'image' : 'video';
    const title = str(item?.title, 200).trim();
    if (!title) fail(type === 'image' ? `أدخل اسم العميل للصورة رقم ${n}.` : `أدخل عنوان الفيديو رقم ${n}.`);
    const sectionId = str(item?.sectionId, 80);
    if (!sectionIds.has(sectionId)) fail(`اختر القسم للعمل رقم ${n}.`);
    const base = {
      id: str(item?.id, 80) || `work-${n}`,
      type,
      title,
      sectionId,
      visible: bool(item?.visible),
    };
    if (type === 'image') {
      return { ...base, imageUrl: mediaUrl(item?.imageUrl, `صورة العمل رقم ${n}`, true), description: str(item?.description, 5000) };
    }
    return {
      ...base,
      storage: 'r2',
      mediaType: 'r2',
      videoUrl: mediaUrl(item?.videoUrl, `فيديو العمل رقم ${n}`, true),
      thumbnailUrl: mediaUrl(item?.thumbnailUrl, `الصورة المصغرة للعمل رقم ${n}`),
      orientation: item?.orientation === 'horizontal' ? 'horizontal' : 'vertical',
      showOnHome: bool(item?.showOnHome),
    };
  });

  const reviews = list(input.reviews).map((r, i) => ({
    id: str(r?.id, 80) || `review-${i + 1}`,
    mode: r?.mode === 'image' ? 'image' : 'text',
    clientName: str(r?.clientName, 200),
    content: str(r?.content, 5000),
    detail: str(r?.detail, 5000),
    imageUrl: mediaUrl(r?.imageUrl, `صورة رأي العميل رقم ${i + 1}`),
    label: str(r?.label, 200),
    visible: bool(r?.visible),
  }));

  return { version: 1, updatedAt: new Date().toISOString(), heroVideos, sections, items, reviews };
}

const emptyData = () => ({ version: 1, heroVideos: [], sections: [], items: [], reviews: [] });

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: 'Origin not allowed.' }, 403);
  if (!env.ADMIN_UPLOAD_PASSWORD) return json({ error: 'لم يتم ضبط كلمة مرور الأدمن في Cloudflare.' }, 503);
  if (!(await passwordMatches(request.headers.get('X-Admin-Password'), env.ADMIN_UPLOAD_PASSWORD))) {
    return json({ error: 'كلمة المرور غير صحيحة.' }, 401);
  }
  if (!env.GITHUB_TOKEN) return json({ error: 'السر GITHUB_TOKEN غير مضبوط في Cloudflare.' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'طلب غير صالح.' }, 400); }

  try {
    if (body.action === 'load') {
      const { data } = await readFile(env);
      return json({ data: data || emptyData(), exists: Boolean(data) });
    }
    if (body.action === 'save') {
      const clean = normalize(body.data);
      await saveFile(env, clean);
      return json({ ok: true, updatedAt: clean.updatedAt });
    }
    return json({ error: 'إجراء غير معروف.' }, 400);
  } catch (error) {
    return json({ error: error.message || 'حدث خطأ غير متوقع.' }, error.status || 500);
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { Allow: 'POST, OPTIONS' } });
  if (context.request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } });
  return onRequestPost(context);
}
