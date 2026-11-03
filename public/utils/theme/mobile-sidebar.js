export function initMobileSidebar() {
  const button = document.createElement('button');
  button.className = 'hamburger';
  button.id = 'hamburger-btn';
  button.setAttribute('aria-label', 'Menu');
  button.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <path d="M2 4h14M2 9h14M2 14h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`;
  button.onclick = () => document.getElementById('sidebar')?.classList.contains('open') ? closeMobileSidebar() : openMobileSidebar();
  document.body.appendChild(button);

  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  overlay.id = 'sidebar-overlay';
  overlay.onclick = closeMobileSidebar;
  document.body.appendChild(overlay);
}

export function openMobileSidebar() {
  document.getElementById('sidebar')?.classList.add('open');
  document.getElementById('sidebar-overlay')?.classList.add('visible');
  document.getElementById('hamburger-btn')?.classList.add('sidebar-open');
}

export function closeMobileSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('visible');
  document.getElementById('hamburger-btn')?.classList.remove('sidebar-open');
}

export function onMobileNavClick() {
  if (window.innerWidth <= 768) closeMobileSidebar();
}
