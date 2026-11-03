let deferredPrompt = null;

export function initPWA() {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;
    setTimeout(() => {
      if (deferredPrompt && !isPWAInstalled()) showInstallBanner();
    }, 30000);
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    dismissInstallBanner();
  });
}

export function isPWAInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

export async function triggerInstall() {
  if (!deferredPrompt) return false;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  dismissInstallBanner();
  return outcome === 'accepted';
}

export function showInstallBanner() {
  if (document.getElementById('pwa-banner')) return;
  const banner = document.createElement('div');
  banner.className = 'pwa-banner';
  banner.id = 'pwa-banner';
  banner.innerHTML = `
    <div class="pwa-banner-text">
      <div style="font-weight:600;margin-bottom:2px">Install EM - Shop Manager Pro</div>
      <div style="font-size:11px;opacity:0.8">Add to home screen for quick access</div>
    </div>
    <button class="pwa-btn-install" onclick="window.__triggerPWAInstall()">Install</button>
    <button class="pwa-btn-dismiss" onclick="window.__dismissPWABanner()">✕</button>`;
  document.body.appendChild(banner);
  window.__triggerPWAInstall = triggerInstall;
  window.__dismissPWABanner = dismissInstallBanner;
}

export function dismissInstallBanner() {
  document.getElementById('pwa-banner')?.remove();
}
