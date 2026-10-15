#!/usr/bin/env python3
"""Apply targeted performance/thumbnail fixes to the current mohamed-amin-web checkout.
Run from the repository root. Creates backups before changing any source file.
"""
from __future__ import annotations
import re
import shutil
import sys
from pathlib import Path
from datetime import datetime
from typing import Optional

ROOT = Path(__file__).resolve().parent
STAMP = datetime.now().strftime('%Y%m%d-%H%M%S')

class PatchError(RuntimeError):
    pass

def rep_once(text: str, old: str, new: str, name: str, *, already: Optional[str] = None) -> str:
    if already and already in text:
        return text
    if old in text:
        return text.replace(old, new, 1)
    raise PatchError(f'لم أجد موضع التعديل المتوقع: {name}. لم يتم حفظ أي ملف.')

def rep_regex(text: str, pattern: str, replacement: str, name: str, *, already: Optional[str] = None, flags=re.S) -> str:
    if already and already in text:
        return text
    out, count = re.subn(pattern, lambda _m: replacement, text, count=1, flags=flags)
    if count == 1:
        return out
    raise PatchError(f'لم أجد موضع التعديل المتوقع: {name}. لم يتم حفظ أي ملف.')

def read_file(path: Path) -> str:
    if not path.exists():
        raise PatchError(f'الملف غير موجود: {path.relative_to(ROOT)}')
    return path.read_text(encoding='utf-8')

def insert_after_regex(text: str, pattern: str, insertion: str, name: str, *, flags=re.S) -> str:
    match = re.search(pattern, text, flags)
    if not match:
        raise PatchError(f'لم أجد موضع التعديل المتوقع: {name}. لم يتم حفظ أي ملف.')
    return text[:match.end()] + insertion + text[match.end():]

def replace_geo_fetch(text: str, label: str) -> str:
    if 'setTimeout(()=>controller.abort(),800)' in text or 'setTimeout(() => controller.abort(), 800)' in text:
        return text
    variants = [
        ("const r=await fetch('https://ipapi.co/json/',{cache:'no-store'});const loc=await r.json();",
         "const controller=new AbortController();const timeoutId=setTimeout(()=>controller.abort(),800);let r;try{r=await fetch('https://ipapi.co/json/',{cache:'no-store',signal:controller.signal})}finally{clearTimeout(timeoutId)}const loc=await r.json();"),
        ("const response=await fetch('https://ipapi.co/json/',{cache:'no-store'});const geo=await response.json();",
         "const controller=new AbortController();const timeoutId=setTimeout(()=>controller.abort(),800);let response;try{response=await fetch('https://ipapi.co/json/',{cache:'no-store',signal:controller.signal})}finally{clearTimeout(timeoutId)}const geo=await response.json();"),
        ('const response=await fetch(\"https://ipapi.co/json/\",{cache:\'no-store\'});const geo=await response.json();',
         "const controller=new AbortController();const timeoutId=setTimeout(()=>controller.abort(),800);let response;try{response=await fetch('https://ipapi.co/json/',{cache:'no-store',signal:controller.signal})}finally{clearTimeout(timeoutId)}const geo=await response.json();"),
    ]
    for old, new in variants:
        if old in text:
            return text.replace(old, new, 1)
    # Some revisions already use a bounded request with another syntax. Leave it intact rather than risk rewriting language logic.
    return text

index = read_file(ROOT / 'index.html')
admin = read_file(ROOT / 'admin.html')
work = read_file(ROOT / 'work.html')
reviews = read_file(ROOT / 'reviews.html')

# ---------- index.html: load fonts without CSS @import; keep same family and weights ----------
font_import = "@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700;800&family=Inter:wght@300;400;500;600;700&display=swap');"
font_links = ('<link rel="preconnect" href="https://fonts.googleapis.com">\n'
              '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
              '<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700;800&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">')
if font_import in index:
    index = index.replace(font_import, '', 1)
    index = rep_once(index, '<title>Mohamed Amin - Editor</title>', '<title>Mohamed Amin - Editor</title>\n' + font_links, 'روابط الخطوط', already='rel="preconnect" href="https://fonts.gstatic.com"')
elif 'href="https://fonts.googleapis.com/css2?family=Barlow+Condensed' not in index:
    raise PatchError('لم أجد استيراد الخطوط المتوقع داخل index.html.')

# Make the homepage visible immediately; country lookup is background-only and bounded.
new_language_function = r'''let languageManuallyChanged = false;
function initializeLanguage() {
  let savedPreference = '';
  try { savedPreference = localStorage.getItem(languagePreferenceKey) || ''; } catch (error) {}
  const browserPrefersArabic = (navigator.languages || [navigator.language || ''])
    .some(language => /^ar(?:-|$)/i.test(language));
  const hasSavedPreference = savedPreference === 'ar' || savedPreference === 'en';
  setLanguage(hasSavedPreference ? savedPreference : (browserPrefersArabic ? 'ar' : 'en'));
  document.documentElement.classList.remove('language-pending');
  if (hasSavedPreference) return;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 800);
  fetch('https://ipapi.co/json/', {
    method: 'GET', headers: { 'Accept': 'application/json' }, cache: 'no-store', signal: controller.signal
  }).then(response => {
    if (!response.ok) throw new Error('Country lookup failed');
    return response.json();
  }).then(locationData => {
    let savedNow = '';
    try { savedNow = localStorage.getItem(languagePreferenceKey) || ''; } catch (error) {}
    if (languageManuallyChanged || savedNow === 'ar' || savedNow === 'en') return;
    const countryCode = String(locationData.country_code || locationData.country || '').toUpperCase();
    setLanguage(arabicCountryCodes.has(countryCode) ? 'ar' : 'en');
  }).catch(() => {}).finally(() => clearTimeout(timeoutId));
}'''
index = rep_regex(index, r'async function initializeLanguage\(\)\s*\{.*?^\}', new_language_function,
                   'تحميل اللغة دون حجب الصفحة', already='let languageManuallyChanged = false;', flags=re.S | re.M)
index = rep_once(index,
    "toggle.addEventListener('click', () => {\n  const nextLanguage",
    "toggle.addEventListener('click', () => {\n  languageManuallyChanged = true;\n  const nextLanguage",
    'تثبيت اختيار اللغة اليدوي', already='languageManuallyChanged = true;')

# Defer hero video source assignment until a hero card is actually visible. Preserve all visuals.
hero_functions = r'''  function heroPlayerMarkup(url, title) {
    const raw = String(url || '').trim();
    if (!isMedia(raw)) return '';
    return `<video data-hero-video data-src="${esc(raw)}" muted loop playsinline preload="none" disablepictureinpicture aria-label="${esc(title || 'Muted hero preview')}"></video><span class="hero-no-controls" aria-hidden="true"></span>`;
  }
  let heroPlaybackObserver = null;
  function activateHeroVideo(card) {
    const video = card.querySelector('video[data-hero-video]');
    if (!video) return;
    if (!video.getAttribute('src') && video.dataset.src) {
      video.src = video.dataset.src;
      video.load();
    }
    video.play().catch(() => {});
  }
  function deactivateHeroVideo(card) {
    const video = card.querySelector('video[data-hero-video]');
    if (!video) return;
    video.pause();
    if (video.hasAttribute('src')) {
      video.removeAttribute('src');
      video.load();
    }
  }
  function observeHeroVideos() {
    if (heroPlaybackObserver) heroPlaybackObserver.disconnect();
    const cards = Array.from(document.querySelectorAll('#heroStage .video-card'));
    if (!('IntersectionObserver' in window)) {
      cards.forEach(card => { if (card.getClientRects().length) activateHeroVideo(card); });
      return;
    }
    heroPlaybackObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.15) activateHeroVideo(entry.target);
        else deactivateHeroVideo(entry.target);
      }
    }, { threshold: [0, 0.15] });
    cards.forEach(card => heroPlaybackObserver.observe(card));
  }
  function renderHeroPreviews(data) {
    const stage = document.getElementById('heroStage');
    if (!stage) return;
    const heroes = (Array.isArray(data.heroVideos) ? data.heroVideos : []).filter(v => v && isMedia(v.url));
    const phone = window.matchMedia('(max-width: 600px)');
    const cards = { left: document.getElementById('heroVideoLeft'), right: document.getElementById('heroVideoRight'), center: document.getElementById('heroVideoMobile') };
    const paint = () => {
      const mobile = phone.matches;
      const list = heroes.filter(v => mobile ? v.showMobile !== false : v.showDesktop !== false).slice(0, mobile ? 3 : 2);
      let slots;
      if (!mobile) slots = { left: list[0], right: list[1], center: null };
      else if (list.length === 1) slots = { left: null, center: list[0], right: null };
      else if (list.length === 2) slots = { left: list[0], center: null, right: list[1] };
      else slots = { left: list[0], center: list[1], right: list[2] };
      Object.entries(cards).forEach(([key, card]) => {
        if (!card) return;
        const item = slots[key];
        card.innerHTML = item ? heroPlayerMarkup(item.url, item.title || '') : '';
        card.style.display = item ? '' : 'none';
      });
      observeHeroVideos();
    };
    paint();
    if (phone.addEventListener) phone.addEventListener('change', paint); else if (phone.addListener) phone.addListener(paint);
  }
'''
index = rep_regex(index, r'  function heroPlayerMarkup\(url, title\)\s*\{.*?(?=  function openMedia\(item\)\s*\{)', hero_functions,
                   'تحميل فيديوهات الهيرو عند ظهورها', already='function observeHeroVideos()', flags=re.S)

# Seamless marquee: measure a full set, duplicate it, and animate exactly one set distance to the right.
if '.work-marquee-set{display:flex;align-items:center;gap:16px;flex:0 0 auto;width:max-content}' not in index:
    track_match = re.search(r'\.work-track\{[^}]+\}', index)
    if not track_match:
        raise PatchError('لم أجد قواعد CSS الخاصة بشريط الأعمال. لم يتم حفظ أي ملف.')
    track_css = track_match.group(0)
    track_css_new = track_css + '.work-marquee-set{display:flex;align-items:center;gap:16px;flex:0 0 auto;width:max-content}@media(max-width:700px){.work-marquee-set{gap:10px}}'
    index = index[:track_match.start()] + track_css_new + index[track_match.end():]
if 'translateX(calc(0px - var(--marquee-distance, 50%)))' not in index:
    index, keyframe_count = re.subn(
        r'@keyframes\s+workMarquee\s*\{[^{}]*\{[^{}]*\}[^{}]*\{[^{}]*\}\s*\}',
        '@keyframes workMarquee{from{transform:translateX(calc(0px - var(--marquee-distance, 50%)))}to{transform:translateX(0)}}',
        index, count=1, flags=re.S)
    if keyframe_count != 1:
        raise PatchError('لم أجد تعريف حركة workMarquee المتوقع. لم يتم حفظ أي ملف.')

new_marquee_function = r'''  function updateHomeMarqueeMetrics(track) {
    const firstSet = track.querySelector('.work-marquee-set');
    if (!firstSet) return;
    const trackStyle = getComputedStyle(track);
    const gap = parseFloat(trackStyle.columnGap || trackStyle.gap || '0') || 0;
    const distance = firstSet.getBoundingClientRect().width + gap;
    if (!(distance > 0)) return;
    track.style.setProperty('--marquee-distance', `${distance}px`);
    track.style.animationDuration = `${Math.max(22, Math.min(42, distance / 55))}s`;
  }
  function renderHomeWork(items) {
    const track = document.getElementById('homeWorkTrack');
    const empty = document.getElementById('homeWorkEmpty');
    if (!track) return;
    // Only a thumbnail selected/uploaded by the site owner is accepted; never create video previews.
    const videos = (items || []).filter(item => item.type === 'video' && item.videoUrl && String(item.thumbnailUrl || '').trim() && item.visible !== false && item.showOnHome !== false);
    if (!videos.length) {
      track.innerHTML = '';
      track.parentElement.style.display = 'none';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';
    track.parentElement.style.display = 'block';
    const featuredVideos = videos.slice(0, 8);
    let run = featuredVideos.slice();
    while (run.length < 7) run = run.concat(featuredVideos);
    run = run.slice(0, Math.max(7, Math.min(12, run.length)));
    const renderSet = () => `<div class="work-marquee-set" aria-hidden="true">${run.map(item => {
      const thumb = String(item.thumbnailUrl || '').trim();
      return `<div class="work-marquee-card ${item.orientation === 'horizontal' ? 'horizontal' : ''}"><img class="marquee-thumb" src="${esc(thumb)}" alt="" loading="lazy" decoding="async"></div>`;
    }).join('')}</div>`;
    track.innerHTML = renderSet() + renderSet();
    updateHomeMarqueeMetrics(track);
    if (track._marqueeResizeObserver) track._marqueeResizeObserver.disconnect();
    if ('ResizeObserver' in window) {
      track._marqueeResizeObserver = new ResizeObserver(() => updateHomeMarqueeMetrics(track));
      track._marqueeResizeObserver.observe(track.parentElement);
      const firstSet = track.querySelector('.work-marquee-set');
      if (firstSet) track._marqueeResizeObserver.observe(firstSet);
    } else {
      window.addEventListener('resize', () => updateHomeMarqueeMetrics(track), { passive: true });
    }
  }
'''
index = rep_regex(index, r'  function renderHomeWork\(items\)\s*\{.*?(?=  function renderHomeReviews\(reviews\)\s*\{)', new_marquee_function,
                   'الصور المصغرة والـ loop المتصل', already='function updateHomeMarqueeMetrics(track)', flags=re.S)

# Lazy decode imagery already visible farther down the page; no styling changes.
index = index.replace('loading="lazy">', 'loading="lazy" decoding="async">')

# ---------- admin.html: thumbnail required before upload/publish; no auto video preview ----------
# Require a manually selected thumbnail in the publish validation, including existing items edited later.
thumbnail_validation = "if(item.type==='video'&&!String(item.thumbnailUrl||'').trim())throw new Error(`أضف صورة مصغرة اخترتها بنفسك للعمل رقم ${i+1}.`);"
if thumbnail_validation not in admin:
    validation_pattern = r"if\(item\.type===['\"]video['\"]&&[^;]*?videoUrl[^;]*?throw new Error\([^;]*?\);"
    admin = insert_after_regex(admin, validation_pattern, "\n   if(item.type==='video'&&!String(item.thumbnailUrl||'').trim())throw new Error(`أضف صورة مصغرة اخترتها بنفسك للعمل رقم ${i+1}.`);", 'فرض الصورة المصغرة عند النشر')
# Update every existing thumbnail label in the editor/form without touching layout or CSS effects.
admin = re.sub(r'(for="workThumbFile">)[^<]*(</label>)', r'\1الصورة المصغرة للفيديو (مطلوبة)\2', admin, count=1)
admin = admin.replace('صورة مصغرة (اختياري)', 'الصورة المصغرة للفيديو (مطلوبة)')
admin = rep_once(admin,
    "function syncWorkForm(){\n   const video=$('workType').value==='video';\n   $('workTitleLabel').textContent=video?'عنوان الفيديو':'اسم العميل';\n   $('workTitle').placeholder=video?'عنوان الفيديو':'اسم العميل';\n   $('workFileLabel').textContent=video?'ملف الفيديو':'ملف الصورة';\n   $('workFile').accept=video?'video/*':'image/*';$('workFile').value='';\n   $('workThumbWrap').style.display=video?'':'none';\n   $('workDescWrap').style.display=video?'none':'';\n  }",
    "function syncWorkForm(){\n   const video=$('workType').value==='video';\n   $('workTitleLabel').textContent=video?'عنوان الفيديو':'اسم العميل';\n   $('workTitle').placeholder=video?'عنوان الفيديو':'اسم العميل';\n   $('workFileLabel').textContent=video?'ملف الفيديو':'ملف الصورة';\n   $('workFile').accept=video?'video/*':'image/*';$('workFile').value='';\n   $('workThumbWrap').style.display=video?'':'none';\n   $('workThumbFile').required=video;\n   $('workThumbWrap').querySelector('label').textContent=video?'الصورة المصغرة للفيديو (مطلوبة)':'صورة مصغرة (اختياري)';\n   if(!video)$('workThumbFile').value='';\n   $('workDescWrap').style.display=video?'none':'';\n  }",
    'إلزام صورة المعاينة في نموذج الرفع', already="$('workThumbFile').required=video;")
old_upload_branch = """    if(type==='video'){
     const orientation=await detectOrientation(file);
     const videoUrl=await uploadToR2(file,'video');
     let thumbnailUrl='';const thumb=$('workThumbFile').files?.[0];
     if(thumb){try{thumbnailUrl=await uploadToR2(thumb,'image');}catch(error){showNotice(`تم رفع الفيديو لكن تعذر رفع الصورة المصغرة: ${error.message}`,'error');}}
     item={id:makeId('work'),type:'video',storage:'r2',mediaType:'r2',title,sectionId,videoUrl,thumbnailUrl,orientation,visible:true,showOnHome:true};
    }else{"""
new_upload_branch = """    if(type==='video'){
     const thumb=$('workThumbFile').files?.[0];
     if(!thumb)throw new Error('اختر صورة مصغرة من جهازك قبل رفع الفيديو.');
     checkFile(thumb,'image');
     const orientation=await detectOrientation(file);
     const thumbnailUrl=await uploadToR2(thumb,'image');
     const videoUrl=await uploadToR2(file,'video');
     item={id:makeId('work'),type:'video',storage:'r2',mediaType:'r2',title,sectionId,videoUrl,thumbnailUrl,orientation,visible:true,showOnHome:true};
    }else{"""
admin = rep_once(admin, old_upload_branch, new_upload_branch, 'رفع الصورة قبل ملف الفيديو', already="if(!thumb)throw new Error('اختر صورة مصغرة من جهازك قبل رفع الفيديو.')")
admin_preview_old = '''    const preview=isImage?(item.imageUrl?`<img class="thumb-prev" src="${esc(item.imageUrl)}" alt="">`:''):(item.thumbnailUrl?`<img class="thumb-prev" src="${esc(item.thumbnailUrl)}" alt="">`:(item.videoUrl?`<video class="thumb-prev" src="${esc(item.videoUrl)}#t=0.1" muted playsinline preload="metadata"></video>`:''));'''
admin_preview_new = '''    const preview=isImage?(item.imageUrl?`<img class="thumb-prev" src="${esc(item.imageUrl)}" alt="" loading="lazy" decoding="async">`:''):(item.thumbnailUrl?`<img class="thumb-prev" src="${esc(item.thumbnailUrl)}" alt="" loading="lazy" decoding="async">`:'<div class="thumb-prev thumbnail-placeholder" aria-hidden="true"></div>');'''
admin = rep_once(admin, admin_preview_old, admin_preview_new, 'إزالة معاينات الفيديو التلقائية من لوحة التحكم', already='thumbnail-placeholder" aria-hidden="true"></div>')
if '.thumb-prev.thumbnail-placeholder{' not in admin:
    admin = rep_once(admin, '</style>', '.thumb-prev.thumbnail-placeholder{width:90px;height:130px;border-radius:9px;background:linear-gradient(145deg,#24162f,#100d15);margin-bottom:12px}</style>', 'خلفية مؤقتة للعمل الذي لا يملك صورة')

# ---------- work.html: no hidden video elements used as thumbnails, bound language lookup ----------
work = rep_once(work,
    'const visual=item.thumbnailUrl?`<img src="${esc(item.thumbnailUrl)}" alt="${esc(item.title)}" loading="lazy">`:`<video src="${esc(item.videoUrl)}#t=0.1" muted playsinline preload="metadata" aria-hidden="true"></video>`;',
    'const visual=item.thumbnailUrl?`<img src="${esc(item.thumbnailUrl)}" alt="${esc(item.title)}" loading="lazy" decoding="async">`:`<span class="thumbnail-placeholder" aria-hidden="true"></span>`;',
    'إزالة الفيديو كمعاينة داخل صفحة الأعمال', already='class="thumbnail-placeholder" aria-hidden="true"')
work = replace_geo_fetch(work, 'صفحة الأعمال')
if '.work-card-image .thumbnail-placeholder{' not in work:
    work = rep_once(work, '</style>', '.work-card-image .thumbnail-placeholder{position:absolute;inset:0;display:block;background:linear-gradient(145deg,#24162f,#100d15)}</style>', 'مساحة بديلة عند غياب الصورة المصغرة')
work = work.replace('loading="lazy">', 'loading="lazy" decoding="async">')

# ---------- reviews.html: bounded country lookup and async image decoding ----------
reviews = replace_geo_fetch(reviews, 'صفحة الآراء')
reviews = reviews.replace('loading="lazy">', 'loading="lazy" decoding="async">')

# Cache-safe range-aware R2 media handler.
media_target = ROOT / 'functions' / 'api' / 'media' / '[key].js'
media_template = ROOT / '_patch_templates' / 'media-key.js'
# Read the replacement from a separate template so the old function can be backed up first.
media_source = media_template.read_text(encoding='utf-8') if media_template.exists() else ''
if not media_source or 'MAX_EDGE_CACHE_BYTES' not in media_source:
    raise PatchError('ملف دالة R2 المحسّنة غير موجود داخل حزمة التعديل.')

# Validate all transformations first; backups and writes happen only after every target matched.
# Final safety checks: refuse to write if any critical change was not applied.
required_fragments = {
    'index.html': ['function observeHeroVideos()', 'function updateHomeMarqueeMetrics(track)', '--marquee-distance', "String(item.thumbnailUrl || '').trim()"],
    'admin.html': ["if(item.type==='video'&&!String(item.thumbnailUrl||'').trim())", 'اختر صورة مصغرة من جهازك قبل رفع الفيديو', 'thumbnail-placeholder'],
    'work.html': ['thumbnail-placeholder', 'decoding=\"async\"'],
    'functions/api/media/[key].js': ['MAX_EDGE_CACHE_BYTES', 'Content-Range', 'status: 206']
}
check_sources = {
    'index.html': index,
    'admin.html': admin,
    'work.html': work,
    'functions/api/media/[key].js': media_source,
}
for name, fragments in required_fragments.items():
    source = check_sources[name]
    missing = [fragment for fragment in fragments if fragment not in source]
    if missing:
        raise PatchError(f'فشل التحقق النهائي من {name}: {missing}. لم يتم حفظ أي ملف.')

outputs = {
    ROOT / 'index.html': index,
    ROOT / 'admin.html': admin,
    ROOT / 'work.html': work,
    ROOT / 'reviews.html': reviews,
    media_target: media_source,
}
for path, content in outputs.items():
    if path.exists():
        backup = path.with_name(path.name + f'.backup-{STAMP}')
        shutil.copy2(path, backup)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8', newline='') as handle:
        handle.write(content)

print('تم تطبيق التعديلات بنجاح.')
print('التصميم والمؤثرات البصرية وتنسيق ملفات الفيديو لم تتغير.')
print('تم إنشاء نسخ احتياطية للملفات الأصلية بأسماء .backup-' + STAMP)
print('الملفات المحدّثة: index.html, admin.html, work.html, reviews.html, functions/api/media/[key].js')
