if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = `
@keyframes shimmer {
  0%   { background-position: -200% 0; }
  100% { background-position:  200% 0; }
}
.skeleton-line {
  height: 12px;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--border) 25%, var(--bg-hover) 50%, var(--border) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s ease-in-out infinite;
  margin-bottom: 8px;
  display: block;
}
.skeleton-card { pointer-events: none; }
.skeleton-table td, .skeleton-table th { padding: 10px 12px; }
.lazy-img { transition: opacity 0.2s; }
.lazy-img[data-src] { opacity: 0; }
.lazy-img:not([data-src]) { opacity: 1; }
`;
  document.head.appendChild(style);
}
