// public/components/modal.js

export function openModal({ title, body, footer = '', size = '' }) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'active-modal';
  overlay.innerHTML = `
    <div class="modal ${size === 'lg' ? 'modal-lg' : ''}">
      <div class="modal-header">
        <span class="modal-title">${title.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span>
        <button class="modal-close" onclick="closeModal()">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4l8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modal-body" id="modal-body">${body}</div>
      ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
    </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

  // Forward scroll events on the dim area to the page behind the modal
  overlay.addEventListener('wheel', (e) => {
    if (e.target.closest('.modal')) return; // let modal body scroll normally
    const main = document.getElementById('main-area');
    if (main) main.scrollTop += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  document.body.appendChild(overlay);
}

export function closeModal() {
  document.getElementById('active-modal')?.remove();
}

export function setModalBody(html) {
  const el = document.getElementById('modal-body');
  if (el) el.innerHTML = html;
}

window.closeModal = closeModal;
