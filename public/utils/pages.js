export const PAGE_LOADERS = {
  agent: () => import('../pages/agent.js').then(m => m.renderAgent),
  dashboard: () => import('../pages/dashboard.js').then(m => m.renderDashboard),
  chat: () => import('../pages/chat.js').then(m => m.renderChat),
  listings: () => import('../pages/listings.js').then(m => m.renderListings),
  create: () => import('../pages/create.js').then(m => m.renderCreate),
  bulk: () => import('../pages/bulk-create.js').then(m => m.renderBulkCreate),
  gallery: () => import('../pages/gallery.js').then(m => m.renderGallery),
  orders: () => import('../pages/orders.js').then(m => m.renderOrders),
  messages: () => import('../pages/messages.js').then(m => m.renderMessages),
  sales: () => import('../pages/sales.js').then(m => m.renderSales),
  reviews: () => import('../pages/reviews.js').then(m => m.renderReviews),
  social: () => import('../pages/social.js').then(m => m.renderSocial),
  schedule: () => import('../pages/schedule.js').then(m => m.renderSchedule),
  analytics: () => import('../pages/analytics.js').then(m => m.renderAnalytics),
  competitor: () => import('../pages/competitor.js').then(m => m.renderCompetitor),
  settings: () => import('../pages/settings.js').then(m => m.renderSettings),
};

export async function loadPageRenderer(pageId) {
  const loader = PAGE_LOADERS[pageId];
  if (!loader) throw new Error(`Unknown page: ${pageId}`);
  return loader();
}
