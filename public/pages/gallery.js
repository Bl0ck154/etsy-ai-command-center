// public/pages/gallery.js — AI-generated image & video gallery (IndexedDB)

import { getAllImages, deleteImage, clearAllImages, countImages,
         getAllVideos, deleteVideo, clearAllVideos, countVideos, saveVideo } from '../utils/image-store.js';
import { toastSuccess, toastError, toastInfo } from '../components/toast.js';
import { escHtml, escJsSingle } from '../utils/format.js';

let _filter     = 'All';
let _activeTab  = 'images'; // 'images' | 'videos'
let _allImages  = null;
let _allVideos  = null;
let _lastRenderedTab = null;

export async function renderGallery(container) {
  _allImages = null;
  _allVideos = null;
  _lastRenderedTab = null;
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Gallery</h1>
        <div class="page-subtitle">AI-generated images &amp; videos saved locally</div>
      </div>
      <button class="btn" id="gallery-clear-btn" onclick="window.__galleryClear()" style="color:var(--red-text);border-color:var(--red-text)">Clear tab</button>
    </div>
    <div class="page-body">
      <div style="display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid var(--border);padding-bottom:0">
        <button id="gtab-images" class="gallery-tab-btn gallery-tab-active" onclick="window.__galleryTab('images')">Images</button>
        <button id="gtab-videos" class="gallery-tab-btn" onclick="window.__galleryTab('videos')">Videos</button>
      </div>
      <div id="gallery-filters" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:20px"></div>
      <div id="gallery-grid"></div>
    </div>`;

  await refreshImages();
}

// ── Tab switching ──────────────────────────────────────────

window.__galleryTab = (tab) => {
  _activeTab = tab;
  document.querySelectorAll('.gallery-tab-btn').forEach(b => b.classList.remove('gallery-tab-active'));
  document.getElementById(`gtab-${tab}`)?.classList.add('gallery-tab-active');
  const filtersEl = document.getElementById('gallery-filters');
  if (filtersEl) filtersEl.innerHTML = '';
  if (tab === 'images') refreshImages();
  else                  refreshVideos();
};

// ── Image tab ─────────────────────────────────────────────

async function refreshImages(rebuildCards = false) {
  const isFirstLoad = !_allImages;
  if (isFirstLoad) {
    try { _allImages = await getAllImages(); }
    catch (error) {
      console.error('Failed to load gallery images:', error);
      _allImages = [];
      toastError('Could not load gallery images');
    }
  }
  const images = Array.isArray(_allImages) ? _allImages : [];
  const switchedFromOtherTab = _lastRenderedTab !== 'images';

  const labels = ['All', ...new Set(images.map(img => img.slotLabel).filter(Boolean))];
  _filter = labels.includes(_filter) ? _filter : 'All';
  const filtersEl = document.getElementById('gallery-filters');
  if (filtersEl) {
    filtersEl.innerHTML = labels.map(l => `
      <button class="btn btn-sm${l === _filter ? ' btn-primary' : ''}"
        onclick="window.__galleryFilter('${escJsSingle(l)}')">${escHtml(l)}</button>
    `).join('');
  }

  const gridEl = document.getElementById('gallery-grid');
  if (!gridEl) return;

  _lastRenderedTab = 'images';

  if (!images.length) {
    gridEl.innerHTML = `
      <div style="text-align:center;padding:80px 20px;color:var(--text-3)">
        <div style="font-size:40px;margin-bottom:16px">🖼</div>
        <div style="font-size:16px;font-weight:600;margin-bottom:8px">No images yet</div>
        <div style="font-size:13px">Generate images on the Create listing page — they'll be saved here automatically.</div>
      </div>`;
    return;
  }

  if (isFirstLoad || rebuildCards || switchedFromOtherTab) {
    gridEl.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px">
        ${images.map(img => renderImageCard(img)).join('')}
      </div>`;
  }

  gridEl.querySelectorAll('.gallery-card').forEach(card => {
    const visible = _filter === 'All' || card.dataset.slotLabel === _filter;
    card.style.display = visible ? '' : 'none';
  });
}

// ── Video tab ─────────────────────────────────────────────

async function refreshVideos(rebuildCards = false) {
  const isFirstLoad = !_allVideos;
  if (isFirstLoad) _allVideos = await getAllVideos();
  const videos = Array.isArray(_allVideos) ? _allVideos : [];
  const switchedFromOtherTab = _lastRenderedTab !== 'videos';

  const filtersEl = document.getElementById('gallery-filters');
  if (filtersEl) filtersEl.innerHTML = '';

  const gridEl = document.getElementById('gallery-grid');
  if (!gridEl) return;

  _lastRenderedTab = 'videos';

  if (!videos.length) {
    gridEl.innerHTML = `
      <div style="text-align:center;padding:80px 20px;color:var(--text-3)">
        <div style="font-size:40px;margin-bottom:16px">🎬</div>
        <div style="font-size:16px;font-weight:600;margin-bottom:8px">No videos yet</div>
        <div style="font-size:13px">Use "Animate" on any image in the gallery — or use the agent to generate a video from a text prompt.</div>
      </div>`;
    return;
  }

  if (isFirstLoad || rebuildCards || switchedFromOtherTab) {
    gridEl.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px">
        ${videos.map(vid => renderVideoCard(vid)).join('')}
      </div>`;
  }
}

// ── Card renderers ─────────────────────────────────────────

function buildFilename(item, ext) {
  const STOP = new Set(['a','an','the','and','or','for','of','in','on','at','to','with','by','from','is','it']);
  const slug = (str, n) => {
    const words = (str || '').toLowerCase().replace(/[^a-z0-9\s]+/g, '').split(/\s+/).filter(w => w && !STOP.has(w));
    return (words.length ? words : (str || '').toLowerCase().split(/\s+/).filter(Boolean)).slice(0, n).join('-') || 'file';
  };
  const label = item.slotLabel || item.label || '';
  const title = item.listingTitle || '';
  return `${slug(title, 3)}-${slug(label || item.prompt, 2)}.${ext}`;
}

function renderImageCard(img) {
  const dataUrl  = `data:${img.mimeType};base64,${img.base64}`;
  const ext      = img.mimeType.split('/')[1]?.split('+')[0] || 'png';
  const date     = new Date(img.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const filename = buildFilename(img, ext);

  return `
    <div class="gallery-card" id="gcard-${img.id}" data-slot-label="${escHtml(img.slotLabel || '')}">
      <div class="gallery-card-img-wrap" title="Click to view">
        <img src="${dataUrl}" alt="${escHtml(img.slotLabel)}" loading="lazy" onclick="window.__galleryView('${img.id}')">
        <div class="vid-play-overlay" style="position:absolute;top:6px;right:6px;display:flex;gap:4px;background:rgba(0,0,0,0.6);padding:4px;border-radius:8px;opacity:0;transition:opacity 0.15s">
          <button class="gal-icon-btn" title="Recreate" onclick="window.__galleryRecreate('${img.id}')" style="color:#fff">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2.5 8a5.5 5.5 0 0 1 8.25-4.76l.25.14M13.5 8a5.5 5.5 0 0 1-8.25 4.76l-.25-.14M11 1v3.5h-3.5M5 15v-3.5h3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <a class="gal-icon-btn" href="${dataUrl}" download="${filename}" title="Download" style="color:#fff;text-decoration:none">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3M3 13h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </a>
          <button class="gal-icon-btn gal-icon-btn-del" title="Delete" onclick="window.__galleryDelete('${img.id}')" style="color:#fff">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M5 4V2.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V4M6 7v5M10 7v5M4 4l.8 9.2a.8.8 0 0 0 .8.8h4.8a.8.8 0 0 0 .8-.8L12 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="gallery-card-meta">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px">
          <div style="min-width:0;flex:1">
            <div style="font-size:9px;color:var(--orange);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-transform:uppercase;letter-spacing:0.5px" title="${escHtml(img.slotLabel || 'Unknown')}">${escHtml(img.slotLabel || 'Unknown')}</div>
            ${img.listingTitle ? `<div style="font-size:11px;color:var(--text-2);margin-top:3px;word-break:break-word;line-height:1.4">${img.listingId ? `<a href="/listings/${img.listingId}" style="color:inherit;text-decoration:none;cursor:pointer" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${escHtml(img.listingTitle)}</a>` : escHtml(img.listingTitle)}</div>` : ''}
            <div style="font-size:10px;color:var(--text-3);margin-top:2px">${date}</div>
          </div>
        </div>
        ${img.prompt ? `<details style="font-size:10px;color:var(--text-3);margin-top:6px;line-height:1.4;cursor:pointer"><summary style="outline:none;user-select:none">Prompt</summary><div style="padding-top:4px;word-break:break-word">${escHtml(img.prompt)}</div></details>` : ''}
        ${(img.provider || img.model) ? `<details style="font-size:9px;color:var(--text-3);margin-top:4px;cursor:pointer;line-height:1.2"><summary style="outline:none;user-select:none">AI Provider</summary><div style="padding-top:2px;color:var(--text-2)">${escHtml(img.provider === 'external' ? `external${img.model ? ` (${img.model})` : ''}` : (img.provider || 'gemini') + (img.model ? ` (${img.model})` : ''))}</div></details>` : ''}
      </div>
    </div>`;
}

function renderVideoCard(vid) {
  const dataUrl = vid.base64 ? `data:${vid.mimeType};base64,${vid.base64}` : '';
  const ext     = (vid.mimeType || 'video/mp4').split('/')[1] || 'mp4';
  const date    = new Date(vid.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const filename = buildFilename(vid, ext);

  return `
    <div class="gallery-card" id="gcard-${vid.id}">
      <div class="gallery-card-img-wrap" title="Click to play" style="cursor:pointer;background:#000;display:flex;align-items:center;justify-content:center">
        ${dataUrl
          ? `<video src="${dataUrl}" style="width:100%;height:100%;object-fit:cover;pointer-events:none" muted loop preload="metadata"></video>`
          : `<div style="color:rgba(255,255,255,0.3);font-size:11px;text-align:center;padding:8px">No preview</div>`}
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.25);opacity:0;transition:opacity 0.15s" class="vid-play-overlay" onclick="window.__galleryViewVideo('${vid.id}')">
          <div style="width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.9);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.3)">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polygon points="3,1 13,7 3,13" fill="#000"/></svg>
          </div>
        </div>
        <div class="vid-play-overlay" style="position:absolute;top:6px;right:6px;display:flex;gap:4px;background:rgba(0,0,0,0.6);padding:4px;border-radius:8px;opacity:0;transition:opacity 0.15s">
          ${dataUrl ? `<a class="gal-icon-btn" href="${dataUrl}" download="${filename}" title="Download" style="color:#fff;text-decoration:none">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3M3 13h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </a>` : ''}
          <button class="gal-icon-btn gal-icon-btn-del" title="Delete" onclick="window.__galleryDeleteVideo('${vid.id}')" style="color:#fff">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M5 4V2.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V4M6 7v5M10 7v5M4 4l.8 9.2a.8.8 0 0 0 .8-.8L12 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="gallery-card-meta">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px">
          <div style="min-width:0;flex:1">
            <span class="badge" style="font-size:10px;background:var(--bg-hover);color:var(--text-2)">Video</span>
            <div style="font-size:10px;color:var(--text-3);margin-top:2px">${date}</div>
          </div>
        </div>
        ${vid.prompt ? `<details style="font-size:10px;color:var(--text-3);margin-top:6px;line-height:1.4;cursor:pointer"><summary style="outline:none;user-select:none">Prompt</summary><div style="padding-top:4px;word-break:break-word">${escHtml(vid.prompt)}</div></details>` : ''}
      </div>
    </div>`;
}

// ── Global handlers ────────────────────────────────────────

window.__galleryFilter = (label) => {
  _filter = label;
  refreshImages();
};

window.__galleryView = (id) => {
  const img = _allImages?.find(i => String(i.id) === String(id));
  if (!img?.base64 || !img?.mimeType?.startsWith('image/')) return;
  const dataUrl = `data:${img.mimeType};base64,${img.base64}`;
  const ext = img.mimeType.split('/')[1] || 'png';

  const isMobile = window.innerWidth < 600;
  const overlay = document.createElement('div');
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9999;display:flex;${isMobile ? 'flex-direction:column;align-items:stretch;overflow-y:auto;' : 'align-items:stretch;justify-content:center;'}padding:${isMobile ? '12px' : '20px'};box-sizing:border-box;gap:${isMobile ? '10px' : '16px'}`;
  overlay.onmousedown = e => { if (e.target === overlay || e.target === imgWrap) overlay.remove(); };

  const onKey = e => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  const imgWrap = document.createElement('div');
  imgWrap.style.cssText = isMobile
    ? 'display:flex;align-items:center;justify-content:center;flex-shrink:0'
    : 'display:flex;align-items:center;justify-content:center;flex:1;min-width:0';
  const imgEl = document.createElement('img');
  imgEl.src = dataUrl;
  imgEl.style.cssText = isMobile
    ? 'width:100%;max-height:45vh;object-fit:contain;border-radius:8px'
    : 'max-width:100%;max-height:100%;object-fit:contain;border-radius:8px';
  imgWrap.appendChild(imgEl);

  const panel = document.createElement('div');
  panel.style.cssText = isMobile
    ? 'display:flex;flex-direction:column;gap:8px;color:#fff;font-size:13px;flex-shrink:0'
    : 'width:240px;flex-shrink:0;display:flex;flex-direction:column;gap:10px;overflow-y:auto;color:#fff;font-size:13px;padding-right:4px';
  panel.onclick = e => e.stopPropagation();

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'align-self:flex-end;background:rgba(255,255,255,0.12);border:none;color:#fff;border-radius:6px;width:28px;height:28px;cursor:pointer;font-size:14px;flex-shrink:0';
  closeBtn.onclick = () => overlay.remove();

  const mkSection = (label, text) => {
    if (!text) return null;
    const wrap = document.createElement('div');
    const lbl = document.createElement('div');
    lbl.style.cssText = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:rgba(255,255,255,0.45);margin-bottom:4px';
    lbl.textContent = label;
    const val = document.createElement('div');
    val.style.cssText = 'color:rgba(255,255,255,0.9);line-height:1.5;word-break:break-word';
    val.textContent = text;
    wrap.appendChild(lbl);
    wrap.appendChild(val);
    return wrap;
  };

  const dlBtn = document.createElement('a');
  dlBtn.href = dataUrl;
  dlBtn.download = buildFilename(img, ext);
  dlBtn.textContent = '↓ Download';
  dlBtn.style.cssText = 'display:block;text-align:center;padding:8px;border-radius:8px;background:rgba(255,255,255,0.12);color:#fff;text-decoration:none;font-weight:600;font-size:13px;cursor:pointer;flex-shrink:0';
  
  panel.appendChild(closeBtn);
  [mkSection('Slot', img.slotLabel), mkSection('Listing', img.listingTitle),
   mkSection('Prompt', img.prompt), mkSection('Generated', new Date(img.createdAt).toLocaleString())
  ].forEach(el => el && panel.appendChild(el));
  panel.appendChild(dlBtn);

  overlay.appendChild(imgWrap);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
};

window.__galleryViewVideo = (id) => {
  const vid = _allVideos?.find(v => String(v.id) === String(id));
  if (!vid || !vid.base64) return;
  const dataUrl = `data:${vid.mimeType};base64,${vid.base64}`;
  const ext = (vid.mimeType || 'video/mp4').split('/')[1] || 'mp4';

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.95);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;gap:16px';
  overlay.onmousedown = e => { if (e.target === overlay || e.target === videoEl) overlay.remove(); };

  const onKey = e => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  const videoEl = document.createElement('video');
  videoEl.src = dataUrl;
  videoEl.controls = true;
  videoEl.autoplay = true;
  videoEl.loop = true;
  videoEl.style.cssText = 'max-width:min(90vw,640px);max-height:70vh;border-radius:10px';
  videoEl.onclick = e => e.stopPropagation();

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px';

  const dlBtn = document.createElement('a');
  dlBtn.href = dataUrl;
  dlBtn.download = buildFilename(vid, ext);
  dlBtn.textContent = '↓ Download';
  dlBtn.style.cssText = 'padding:8px 16px;border-radius:8px;background:rgba(255,255,255,0.12);color:#fff;text-decoration:none;font-weight:600;font-size:13px';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕ Close';
  closeBtn.style.cssText = 'padding:8px 16px;border-radius:8px;background:rgba(255,255,255,0.12);color:#fff;border:none;font-weight:600;font-size:13px;cursor:pointer';
  closeBtn.onclick = () => overlay.remove();

  actions.append(dlBtn, closeBtn);
  overlay.append(videoEl, actions);
  document.body.appendChild(overlay);
};

window.__galleryDelete = async (id) => {
  if (!confirm('Delete this image?')) return;
  await deleteImage(id);
  if (_allImages) _allImages = _allImages.filter(img => String(img.id) !== String(id));
  document.getElementById(`gcard-${String(id)}`)?.remove();
  if (!_allImages?.length) refreshImages(true);
  toastSuccess('Image deleted');
};

window.__galleryDeleteVideo = async (id) => {
  if (!confirm('Delete this video?')) return;
  await deleteVideo(id);
  if (_allVideos) _allVideos = _allVideos.filter(v => String(v.id) !== String(id));
  document.getElementById(`gcard-${String(id)}`)?.remove();
  if (!_allVideos?.length) refreshVideos(true);
  toastSuccess('Video deleted');
};

window.__galleryClear = async () => {
  if (_activeTab === 'videos') {
    const c = await countVideos();
    if (!c) return;
    if (!confirm(`Delete all ${c} videos? This cannot be undone.`)) return;
    await clearAllVideos();
    _allVideos = null;
    toastSuccess('Videos cleared');
    refreshVideos(true);
  } else {
    const c = await countImages();
    if (!c) return;
    if (!confirm(`Delete all ${c} images from your gallery? This cannot be undone.`)) return;
    await clearAllImages();
    _allImages = null;
    toastSuccess('Gallery cleared');
    refreshImages(true);
  }
};

window.__galleryRecreate = (id) => {
  const img = _allImages?.find(i => String(i.id) === String(id));
  if (!img) return;
  const newPrompt = prompt('Edit prompt to recreate this image:', img.prompt || '');
  if (!newPrompt) return;
  // Route back to the agent page, pre-filled
  const input = document.getElementById('chat-input');
  if (input) {
    document.querySelectorAll('.app-nav a').forEach(a => a.classList.remove('active'));
    document.querySelector('.app-nav a[href="#agent"]')?.classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('page-active'));
    document.getElementById('page-agent')?.classList.add('page-active');
    input.value = `Generate 1 image. Prompt: ${newPrompt}`;
    input.focus();
  }
};

// ── Styles ─────────────────────────────────────────────────
const style = document.createElement('style');
style.textContent = `
.gallery-tab-btn {
  padding: 8px 16px; border: none; border-bottom: 2px solid transparent;
  background: transparent; color: var(--text-3); font-size: 13px; font-weight: 500;
  cursor: pointer; border-radius: 0; transition: color 0.12s;
  margin-bottom: -1px;
}
.gallery-tab-btn:hover { color: var(--text); }
.gallery-tab-active { color: var(--orange) !important; border-bottom-color: var(--orange) !important; font-weight: 600 !important; }
.gallery-card {
  border-radius: var(--radius-lg); overflow: hidden;
  border: 1px solid var(--border); background: var(--bg-card);
  transition: box-shadow 0.15s;
}
.gallery-card:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.10); }
.gallery-card:hover .vid-play-overlay { opacity: 1 !important; }
.gallery-card-img-wrap {
  position: relative; aspect-ratio: 1; overflow: hidden;
  background: var(--bg-secondary); cursor: pointer;
}
.gallery-card-img-wrap img,
.gallery-card-img-wrap video {
  width: 100%; height: 100%; object-fit: cover; display: block;
  transition: transform 0.2s;
}
.gallery-card:hover .gallery-card-img-wrap img,
.gallery-card:hover .gallery-card-img-wrap video { transform: scale(1.03); }
.gallery-card-meta { padding: 8px 10px 10px; }
.gal-icon-btn {
  background: transparent; color: var(--text-3); border: none;
  border-radius: 6px; padding: 6px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.12s, color 0.12s;
}
.gal-icon-btn:hover { background: var(--bg-hover); color: var(--text); }
.vid-play-overlay .gal-icon-btn:hover { background: rgba(255,255,255,0.25) !important; color: #fff !important; }
.gal-icon-btn-del:hover { color: var(--red-text); }
`;
document.head.appendChild(style);
