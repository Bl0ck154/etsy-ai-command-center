import {
  getImage,
  getImagesByIds,
  listGalleryImageSummaries,
  warmGalleryImageSummaries,
} from '../utils/image-store.js';

const PICKER_ID = 'gallery-picker-overlay';
const STYLE_ID = 'gallery-picker-styles';
let activePickerClose = null;

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .gallery-picker-overlay {
      position: fixed; inset: 0; z-index: 9999; padding: 20px;
      display: flex; background: rgba(0, 0, 0, 0.72); box-sizing: border-box;
    }
    .gallery-picker-dialog {
      width: min(1120px, 100%); max-height: 100%; margin: auto; overflow: hidden;
      display: flex; flex-direction: column; background: var(--bg, #161616);
      color: var(--text, #f5f5f5); border: 1px solid var(--border, #333);
      border-radius: 8px; box-shadow: 0 18px 55px rgba(0, 0, 0, 0.42);
    }
    .gallery-picker-header {
      display: flex; align-items: center; gap: 12px; padding: 14px 16px;
      border-bottom: 1px solid var(--border, #333); flex: 0 0 auto;
    }
    .gallery-picker-heading { min-width: 0; flex: 1; }
    .gallery-picker-heading h2 { margin: 0; font-size: 16px; line-height: 1.35; letter-spacing: 0; }
    .gallery-picker-heading p {
      margin: 3px 0 0; color: var(--text-3, #aaa); font-size: 12px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .gallery-picker-actions { display: flex; align-items: center; gap: 8px; }
    .gallery-picker-status { color: var(--text-3, #aaa); font-size: 12px; }
    .gallery-picker-button {
      min-height: 34px; border: 1px solid var(--border, #444); border-radius: 6px;
      padding: 7px 12px; background: var(--bg-card, #222); color: inherit;
      font: inherit; font-size: 13px; cursor: pointer;
    }
    .gallery-picker-button:hover:not(:disabled) { border-color: var(--border-2, #777); }
    .gallery-picker-button:focus-visible, .gallery-picker-card:focus-visible,
    .gallery-picker-preview-button:focus-visible { outline: 2px solid var(--orange, #f56400); outline-offset: 2px; }
    .gallery-picker-button:disabled { cursor: default; opacity: 0.5; }
    .gallery-picker-confirm { border-color: var(--orange, #f56400); background: var(--orange, #f56400); color: #fff; font-weight: 600; }
    .gallery-picker-close { width: 34px; padding: 0; font-size: 20px; line-height: 1; }
    .gallery-picker-body { min-height: 220px; overflow-y: auto; padding: 14px; }
    .gallery-picker-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
      gap: 10px; align-content: start;
    }
    .gallery-picker-card {
      position: relative; min-width: 0; padding: 0; overflow: hidden; cursor: pointer;
      border: 2px solid transparent; border-radius: 8px; background: var(--bg-card, #222);
      color: inherit; text-align: left; aspect-ratio: 1; font: inherit;
    }
    .gallery-picker-card:hover { border-color: var(--border-2, #666); }
    .gallery-picker-card[aria-pressed="true"] { border-color: var(--orange, #f56400); }
    .gallery-picker-thumb, .gallery-picker-placeholder {
      width: 100%; height: 100%; display: block; object-fit: cover;
    }
    .gallery-picker-placeholder {
      display: flex; align-items: center; justify-content: center; padding: 20px;
      box-sizing: border-box; text-align: center; color: var(--text-3, #aaa);
      background: var(--bg-hover, #292929); font-size: 12px;
    }
    .gallery-picker-label {
      position: absolute; left: 0; right: 0; bottom: 0; padding: 22px 8px 7px;
      color: #fff; font-size: 11px; line-height: 1.3; overflow: hidden;
      white-space: nowrap; text-overflow: ellipsis;
      background: linear-gradient(transparent, rgba(0, 0, 0, 0.78));
    }
    .gallery-picker-order {
      position: absolute; top: 7px; left: 7px; min-width: 26px; height: 26px;
      padding: 0 6px; box-sizing: border-box; display: none; align-items: center;
      justify-content: center; border-radius: 50%; background: var(--orange, #f56400);
      color: #fff; font-size: 12px; font-weight: 700; box-shadow: 0 1px 5px rgba(0,0,0,.35);
    }
    .gallery-picker-card[aria-pressed="true"] .gallery-picker-order { display: flex; }
    .gallery-picker-preview-button {
      position: absolute; top: 7px; right: 7px; min-width: 42px; height: 28px;
      padding: 0 8px; border: 1px solid rgba(255,255,255,.42); border-radius: 6px;
      background: rgba(0,0,0,.66); color: #fff; font: inherit; font-size: 11px; cursor: pointer;
    }
    .gallery-picker-empty {
      min-height: 260px; display: flex; align-items: center; justify-content: center;
      color: var(--text-3, #aaa); text-align: center; font-size: 13px;
    }
    .gallery-picker-error { color: var(--red, #ef4444); }
    .gallery-picker-lightbox {
      position: absolute; inset: 0; z-index: 2; display: flex; align-items: center;
      justify-content: center; padding: 24px; background: rgba(0,0,0,.88); box-sizing: border-box;
    }
    .gallery-picker-lightbox[hidden] { display: none; }
    .gallery-picker-lightbox-image { max-width: 100%; max-height: 100%; object-fit: contain; }
    .gallery-picker-lightbox-message { color: #fff; font-size: 13px; }
    .gallery-picker-lightbox-close, .gallery-picker-lightbox-nav {
      position: absolute; z-index: 1; border: 1px solid rgba(255,255,255,.35);
      background: rgba(0,0,0,.68); color: #fff; border-radius: 6px; cursor: pointer;
      font: inherit;
    }
    .gallery-picker-lightbox-close { top: 16px; right: 16px; width: 38px; height: 38px; font-size: 22px; }
    .gallery-picker-lightbox-nav { top: 50%; width: 42px; height: 48px; transform: translateY(-50%); font-size: 22px; }
    .gallery-picker-lightbox-prev { left: 16px; }
    .gallery-picker-lightbox-next { right: 16px; }
    @media (max-width: 680px) {
      .gallery-picker-overlay { padding: 0; }
      .gallery-picker-dialog { width: 100%; height: 100%; max-height: none; border: 0; border-radius: 0; }
      .gallery-picker-header { align-items: flex-start; flex-wrap: wrap; }
      .gallery-picker-heading { flex-basis: calc(100% - 46px); }
      .gallery-picker-actions { width: 100%; }
      .gallery-picker-status { flex: 1; }
      .gallery-picker-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  `;
  document.head.appendChild(style);
}

function createElement(tag, className, text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function sortForListing(summaries, listingTitle) {
  const normalizedTitle = String(listingTitle || '').trim().toLocaleLowerCase();
  return summaries.slice().sort((a, b) => {
    if (normalizedTitle) {
      const aMatches = String(a.listingTitle || '').trim().toLocaleLowerCase() === normalizedTitle;
      const bMatches = String(b.listingTitle || '').trim().toLocaleLowerCase() === normalizedTitle;
      if (aMatches !== bMatches) return Number(bMatches) - Number(aMatches);
    }
    return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
  });
}

export function closeGalleryPicker() {
  if (activePickerClose) activePickerClose('replaced');
  else document.getElementById(PICKER_ID)?.remove();
}

/**
 * Opens immediately and loads only lightweight gallery summaries.
 * `onConfirm(records, context)` receives full records in exact click order.
 */
export function openGalleryPicker({
  listingTitle = '',
  maxSelection = 20,
  title = 'Choose images from Gallery',
  confirmLabel = 'Add selected',
  onConfirm = null,
  onClose = null,
} = {}) {
  closeGalleryPicker();
  installStyles();

  const previousFocus = document.activeElement;
  const overlay = createElement('div', 'gallery-picker-overlay');
  overlay.id = PICKER_ID;
  const dialog = createElement('section', 'gallery-picker-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'gallery-picker-title');

  const header = createElement('header', 'gallery-picker-header');
  const heading = createElement('div', 'gallery-picker-heading');
  const headingText = createElement('h2', '', title);
  headingText.id = 'gallery-picker-title';
  heading.appendChild(headingText);
  if (listingTitle) heading.appendChild(createElement('p', '', listingTitle));

  const actions = createElement('div', 'gallery-picker-actions');
  const status = createElement('span', 'gallery-picker-status', 'Loading saved images...');
  status.id = 'gp-sel-count';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const confirmButton = createElement('button', 'gallery-picker-button gallery-picker-confirm', confirmLabel);
  confirmButton.id = 'gp-add-btn';
  confirmButton.type = 'button';
  confirmButton.disabled = true;
  const closeButton = createElement('button', 'gallery-picker-button gallery-picker-close', 'x');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close gallery');
  actions.append(status, confirmButton, closeButton);
  header.append(heading, actions);

  const body = createElement('div', 'gallery-picker-body');
  const grid = createElement('div', 'gallery-picker-grid');
  grid.setAttribute('role', 'list');
  body.appendChild(grid);

  const lightbox = createElement('div', 'gallery-picker-lightbox');
  lightbox.hidden = true;
  lightbox.setAttribute('role', 'dialog');
  lightbox.setAttribute('aria-modal', 'true');
  lightbox.setAttribute('aria-label', 'Image preview');
  const previewMessage = createElement('div', 'gallery-picker-lightbox-message');
  const previewImage = createElement('img', 'gallery-picker-lightbox-image');
  previewImage.alt = '';
  const previewClose = createElement('button', 'gallery-picker-lightbox-close', 'x');
  previewClose.type = 'button';
  previewClose.setAttribute('aria-label', 'Close preview');
  const previewPrevious = createElement('button', 'gallery-picker-lightbox-nav gallery-picker-lightbox-prev', '<');
  previewPrevious.type = 'button';
  previewPrevious.setAttribute('aria-label', 'Previous image');
  const previewNext = createElement('button', 'gallery-picker-lightbox-nav gallery-picker-lightbox-next', '>');
  previewNext.type = 'button';
  previewNext.setAttribute('aria-label', 'Next image');
  lightbox.append(previewMessage, previewImage, previewClose, previewPrevious, previewNext);

  dialog.append(header, body);
  overlay.append(dialog, lightbox);
  document.body.appendChild(overlay);
  closeButton.focus();

  const selectedIds = [];
  const summariesById = new Map();
  let summaries = [];
  let warming = true;
  let previewIndex = -1;
  let closed = false;
  let renderQueued = false;
  let confirmedRecords = [];
  const selectionLimit = Math.max(1, Number(maxSelection) || 20);

  let resolveClosed;
  const closedPromise = new Promise(resolve => { resolveClosed = resolve; });

  const close = (reason = 'dismissed') => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
    if (activePickerClose === close) activePickerClose = null;
    previousFocus?.focus?.();
    try { onClose?.(reason); } catch { /* closing must remain reliable */ }
    resolveClosed({ reason, selectedIds: selectedIds.slice(), records: confirmedRecords.slice() });
  };

  const updateSelectionStatus = () => {
    const count = selectedIds.length;
    confirmButton.disabled = count === 0;
    if (count) status.textContent = `${count} selected in attachment order`;
    else if (warming) status.textContent = 'Loading saved images...';
    else status.textContent = summaries.length ? 'Select images in attachment order' : 'No saved images';
  };

  const toggleSelection = (id) => {
    const index = selectedIds.indexOf(id);
    if (index >= 0) selectedIds.splice(index, 1);
    else if (selectedIds.length < selectionLimit) selectedIds.push(id);
    else {
      status.textContent = `You can select up to ${selectionLimit} images`;
      return;
    }
    render();
  };

  const showPreview = async (id) => {
    previewIndex = summaries.findIndex(summary => String(summary.id) === String(id));
    lightbox.hidden = false;
    previewImage.hidden = true;
    previewMessage.hidden = false;
    previewMessage.textContent = 'Loading full image...';
    previewClose.focus();
    const requestedId = id;
    const record = await getImage(id).catch(() => null);
    if (lightbox.hidden || String(summaries[previewIndex]?.id) !== String(requestedId)) return;
    if (!record) {
      previewMessage.textContent = 'This image is no longer available.';
      return;
    }
    previewImage.src = `data:${record.mimeType};base64,${record.base64}`;
    previewImage.alt = record.slotLabel || record.listingTitle || 'Gallery image preview';
    previewImage.hidden = false;
    previewMessage.hidden = true;
  };

  const closePreview = () => {
    lightbox.hidden = true;
    previewImage.removeAttribute('src');
    const currentId = summaries[previewIndex]?.id;
    Array.from(grid.querySelectorAll('[data-gallery-id]'))
      .find(element => element.dataset.galleryId === String(currentId || ''))
      ?.focus();
  };

  const movePreview = (direction) => {
    if (!summaries.length) return;
    previewIndex = (previewIndex + direction + summaries.length) % summaries.length;
    showPreview(summaries[previewIndex].id);
  };

  function render() {
    if (closed) return;
    grid.replaceChildren();
    if (!summaries.length) {
      grid.appendChild(createElement(
        'div',
        'gallery-picker-empty',
        warming ? 'Preparing saved images...' : 'No images have been saved to this Gallery yet.',
      ));
      updateSelectionStatus();
      return;
    }
    for (const summary of summaries) {
      const id = String(summary.id);
      const order = selectedIds.indexOf(id);
      const card = createElement('button', 'gallery-picker-card');
      card.type = 'button';
      card.dataset.galleryId = id;
      card.dataset.id = id;
      card.setAttribute('aria-pressed', order >= 0 ? 'true' : 'false');
      card.setAttribute('aria-label', `${order >= 0 ? `Selected ${order + 1}. ` : ''}${summary.slotLabel || summary.listingTitle || 'Gallery image'}`);
      if (summary.thumbnailDataUrl) {
        const image = createElement('img', 'gallery-picker-thumb');
        image.src = summary.thumbnailDataUrl;
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        card.appendChild(image);
      } else {
        card.appendChild(createElement('span', 'gallery-picker-placeholder', warming ? 'Preparing preview...' : 'Preview unavailable'));
      }
      const orderBadge = createElement('span', 'gallery-picker-order', order >= 0 ? String(order + 1) : '');
      orderBadge.setAttribute('aria-hidden', 'true');
      const label = createElement('span', 'gallery-picker-label', summary.slotLabel || summary.listingTitle || 'Saved image');
      card.append(orderBadge, label);
      card.addEventListener('click', () => toggleSelection(id));

      const viewButton = createElement('button', 'gallery-picker-preview-button', 'View');
      viewButton.type = 'button';
      viewButton.setAttribute('aria-label', `View ${summary.slotLabel || summary.listingTitle || 'gallery image'}`);
      viewButton.addEventListener('click', event => {
        event.stopPropagation();
        showPreview(id);
      });
      const item = createElement('div');
      item.style.position = 'relative';
      item.setAttribute('role', 'listitem');
      item.append(card, viewButton);
      grid.appendChild(item);
    }
    updateSelectionStatus();
  }

  const queueRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : callback => setTimeout(callback, 0);
    schedule(() => {
      renderQueued = false;
      summaries = sortForListing(Array.from(summariesById.values()), listingTitle);
      render();
    });
  };

  const onKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!lightbox.hidden) closePreview();
      else close('dismissed');
      return;
    }
    if (!lightbox.hidden && event.key === 'ArrowLeft') movePreview(-1);
    if (!lightbox.hidden && event.key === 'ArrowRight') movePreview(1);
    if (event.key === 'Tab') {
      const scope = lightbox.hidden ? dialog : lightbox;
      const focusable = Array.from(scope.querySelectorAll('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  activePickerClose = close;
  document.addEventListener('keydown', onKeyDown);
  closeButton.addEventListener('click', () => close('dismissed'));
  overlay.addEventListener('click', event => {
    if (event.target === overlay) close('dismissed');
  });
  previewClose.addEventListener('click', closePreview);
  previewPrevious.addEventListener('click', () => movePreview(-1));
  previewNext.addEventListener('click', () => movePreview(1));
  lightbox.addEventListener('click', event => {
    if (event.target === lightbox) closePreview();
  });

  confirmButton.addEventListener('click', async () => {
    if (!selectedIds.length || confirmButton.disabled) return;
    confirmButton.disabled = true;
    confirmButton.textContent = 'Adding...';
    status.classList.remove('gallery-picker-error');
    status.textContent = 'Loading selected images...';
    try {
      const records = await getImagesByIds(selectedIds);
      if (records.length !== selectedIds.length) throw new Error('One or more selected images are no longer available.');
      confirmedRecords = records;
      const result = await onConfirm?.(records, { selectedIds: selectedIds.slice(), close });
      if (result !== false) close('confirmed');
    } catch (error) {
      status.classList.add('gallery-picker-error');
      status.textContent = error?.message || 'Could not add selected images.';
      confirmButton.disabled = false;
      confirmButton.textContent = confirmLabel;
    }
  });

  const ready = (async () => {
    const initial = await listGalleryImageSummaries();
    for (const summary of initial) summariesById.set(String(summary.id), summary);
    summaries = sortForListing(initial, listingTitle);
    render();
    await warmGalleryImageSummaries({
      onSummary: summary => {
        summariesById.set(String(summary.id), summary);
        queueRender();
      },
    });
    const complete = await listGalleryImageSummaries();
    for (const summary of complete) summariesById.set(String(summary.id), summary);
    warming = false;
    summaries = sortForListing(Array.from(summariesById.values()), listingTitle);
    render();
    return summaries.slice();
  })().catch(error => {
    warming = false;
    render();
    status.classList.add('gallery-picker-error');
    status.textContent = 'Could not load Gallery.';
    console.error('Gallery picker failed to load:', error);
    return [];
  });

  render();
  return {
    close,
    ready,
    closed: closedPromise,
    getSelectedIds: () => selectedIds.slice(),
  };
}
