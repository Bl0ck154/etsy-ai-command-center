const imageObserver = typeof IntersectionObserver !== 'undefined'
  ? new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img.dataset.src) {
            img.src = img.dataset.src;
            img.removeAttribute('data-src');
            imageObserver.unobserve(img);
          }
        }
      });
    }, { rootMargin: '200px' })
  : null;

export function lazyImg(src, cls = '', style = '', alt = '') {
  if (!imageObserver) {
    return `<img src="${src}" class="${cls}" style="${style}" alt="${alt}" loading="lazy">`;
  }
  return `<img data-src="${src}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
    class="${cls} lazy-img" style="${style};background:var(--bg-hover)" alt="${alt}"
    onload="this.style.background='';this.style.visibility='visible'"
    onerror="this.onerror=null;this.style.visibility='hidden'" loading="lazy">`;
}

export function observeLazyImages(container = document) {
  if (!imageObserver) return;
  container.querySelectorAll('.lazy-img[data-src]').forEach(img => {
    imageObserver.observe(img);
  });
}
