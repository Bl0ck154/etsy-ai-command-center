// public/pages/sales.js — Sales & Discounts with calendar view
import { etsy } from '../utils/api.js';
import { toastSuccess, toastError } from '../components/toast.js';
import { openModal, closeModal } from '../components/modal.js';

let state = {
  discounts: [],
  loading: false,
  calendarMonth: new Date().getMonth(),
  calendarYear: new Date().getFullYear(),
};

export async function renderSales(container) {
  state.discounts = [];
  state.calendarMonth = new Date().getMonth();
  state.calendarYear = new Date().getFullYear();

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Sales & Discounts</div>
        <div class="page-subtitle" id="sales-subtitle">Loading…</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-sm" onclick="window._salesRefresh()">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M14 8A6 6 0 1 1 2.8 4.5M2 2v4h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Refresh
        </button>
        <button class="btn btn-primary btn-sm" onclick="window._salesCreate()">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          New Discount
        </button>
      </div>
    </div>
    <div class="page-body">
      <div class="sales-layout" style="display:grid;grid-template-columns:1fr 340px;gap:16px;align-items:start">
        <div>
          <div class="card" id="discounts-list" style="padding:0;overflow:hidden">
            <div style="padding:32px;text-align:center;color:var(--text-2)">Loading…</div>
          </div>
        </div>
        <div>
          <div class="card" id="sales-calendar" style="padding:16px"></div>
        </div>
      </div>
    </div>`;

  window._salesRefresh = () => loadDiscounts(true);
  window._salesCreate = openCreateModal;
  window._salesDelete = deleteDiscount;
  window._salesToggle = toggleDiscount;
  window._salesCalPrev = () => { if (--state.calendarMonth < 0) { state.calendarMonth = 11; state.calendarYear--; } renderCalendar(); };
  window._salesCalNext = () => { if (++state.calendarMonth > 11) { state.calendarMonth = 0; state.calendarYear++; } renderCalendar(); };

  await loadDiscounts();
}

async function loadDiscounts(force = false) {
  state.loading = true;
  try {
    const result = await etsy.getDiscounts();
    state.discounts = result.results || result.discounts || (Array.isArray(result) ? result : []);
  } catch (e) {
    // Etsy discount API may not be available for all shops
    state.discounts = [];
    const sub = document.getElementById('sales-subtitle');
    if (sub) sub.textContent = 'Discount API not available for this shop type';
  }
  state.loading = false;
  renderDiscountList();
  renderCalendar();
  const sub = document.getElementById('sales-subtitle');
  if (sub) sub.textContent = `${state.discounts.length} discount${state.discounts.length !== 1 ? 's' : ''}`;
}

function renderDiscountList() {
  const el = document.getElementById('discounts-list');
  if (!el) return;

  if (!state.discounts.length) {
    el.innerHTML = `
      <div style="padding:48px 32px;text-align:center">
        <div style="font-size:36px;margin-bottom:12px">🏷️</div>
        <div style="font-weight:600;color:var(--text);margin-bottom:6px">No active discounts</div>
        <div style="color:var(--text-2);font-size:13px;margin-bottom:16px">Create a discount to run a sale on your Etsy shop.</div>
        <button class="btn btn-primary btn-sm" onclick="window._salesCreate()">Create first discount</button>
      </div>`;
    return;
  }

  const now = Date.now() / 1000;
  const rows = state.discounts.map(d => {
    const start = d.start_date || 0;
    const end = d.end_date || 0;
    const active = d.seller_active && start <= now && (!end || end >= now);
    const upcoming = d.seller_active && start > now;
    const expired = end && end < now;
    const status = expired ? 'expired' : upcoming ? 'upcoming' : active ? 'active' : 'paused';
    const statusLabel = { active: 'Active', upcoming: 'Upcoming', expired: 'Expired', paused: 'Paused' }[status];
    const statusColor = { active: 'var(--green)', upcoming: 'var(--orange)', expired: 'var(--text-3)', paused: 'var(--text-3)' }[status];

    const startStr = start ? new Date(start * 1000).toLocaleDateString() : '—';
    const endStr = end ? new Date(end * 1000).toLocaleDateString() : 'No end date';
    const value = d.discount_type === 'free_shipping' ? 'Free shipping'
      : d.discount_type === 'fixed_amount' ? `$${(d.discount_value / 100).toFixed(2)} off`
      : `${d.discount_value}% off`;

    return `<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border)">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;color:var(--text);margin-bottom:2px">${escHtml(d.discount_name || 'Unnamed discount')}</div>
        <div style="font-size:12px;color:var(--text-2)">${value} · ${startStr} → ${endStr}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:11px;font-weight:600;color:${statusColor};background:${statusColor}18;padding:2px 8px;border-radius:20px">${statusLabel}</span>
        ${status !== 'expired' ? `<button class="btn btn-sm" onclick="window._salesToggle(${d.discount_id},${!d.seller_active})" title="${d.seller_active ? 'Pause' : 'Resume'}">
          ${d.seller_active ? pauseIcon() : playIcon()}
        </button>` : ''}
        <button class="btn btn-sm" style="color:var(--red-text)" onclick="window._salesDelete(${d.discount_id})" title="Delete">
          ${trashIcon()}
        </button>
      </div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
      <div style="font-size:13px;font-weight:600;color:var(--text)">Discounts</div>
    </div>
    ${rows}`;
}

function renderCalendar() {
  const el = document.getElementById('sales-calendar');
  if (!el) return;

  const year = state.calendarYear;
  const month = state.calendarMonth;
  const monthName = new Date(year, month, 1).toLocaleString('default', { month: 'long', year: 'numeric' });

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();

  // Build a set of days that have active discounts
  const activeDays = new Set();
  const upcomingDays = new Set();
  for (const d of state.discounts) {
    if (!d.seller_active) continue;
    const start = d.start_date ? new Date(d.start_date * 1000) : null;
    const end = d.end_date ? new Date(d.end_date * 1000) : null;
    if (!start) continue;
    const rangeEnd = end || new Date(year, month + 1, 0);
    for (let day = 1; day <= daysInMonth; day++) {
      const dt = new Date(year, month, day);
      if (dt >= start && dt <= rangeEnd) {
        const now = new Date(); now.setHours(0,0,0,0);
        if (start > now) upcomingDays.add(day);
        else activeDays.add(day);
      }
    }
  }

  const dayHeaders = ['Su','Mo','Tu','We','Th','Fr','Sa'].map(d =>
    `<div style="text-align:center;font-size:11px;font-weight:600;color:var(--text-3);padding:4px 0">${d}</div>`
  ).join('');

  let cells = '';
  for (let i = 0; i < firstDay; i++) cells += `<div></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const isToday = day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
    const isActive = activeDays.has(day);
    const isUpcoming = upcomingDays.has(day);
    const bg = isActive ? 'var(--orange)' : isUpcoming ? 'var(--orange-hover,#f97316)' : 'transparent';
    const color = (isActive || isUpcoming) ? '#fff' : isToday ? 'var(--orange)' : 'var(--text)';
    const opacity = isUpcoming ? '0.6' : '1';
    const outline = isToday && !isActive && !isUpcoming ? '2px solid var(--orange)' : 'none';
    cells += `<div style="text-align:center;padding:5px 2px">
      <span style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:${bg};color:${color};font-size:12px;opacity:${opacity};outline:${outline};font-weight:${isToday?'700':'400'}">${day}</span>
    </div>`;
  }

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <button class="btn btn-sm" onclick="window._salesCalPrev()">‹</button>
      <div style="font-size:13px;font-weight:600;color:var(--text)">${monthName}</div>
      <button class="btn btn-sm" onclick="window._salesCalNext()">›</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px">
      ${dayHeaders}
      ${cells}
    </div>
    <div style="margin-top:12px;display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-2)">
        <span style="width:10px;height:10px;border-radius:50%;background:var(--orange);display:inline-block"></span> Active sale
      </div>
      <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-2)">
        <span style="width:10px;height:10px;border-radius:50%;background:var(--orange);opacity:0.5;display:inline-block"></span> Upcoming sale
      </div>
    </div>`;
}

function openCreateModal() {
  const today = new Date().toISOString().split('T')[0];
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

  openModal(`
    <div style="padding:24px;width:420px;max-width:100%">
      <div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:20px">New Discount</div>

      <div style="display:flex;flex-direction:column;gap:14px">
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-2);display:block;margin-bottom:4px">Discount name</label>
          <input id="sale-name" type="text" class="form-input" placeholder="e.g. Summer Sale 20%" style="width:100%;box-sizing:border-box">
        </div>

        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-2);display:block;margin-bottom:4px">Discount type</label>
          <select id="sale-type" class="form-input" style="width:100%" onchange="window._salesTypeChange(this.value)">
            <option value="percent">Percentage off</option>
            <option value="fixed_amount">Fixed amount off</option>
            <option value="free_shipping">Free shipping</option>
          </select>
        </div>

        <div id="sale-value-row">
          <label style="font-size:12px;font-weight:600;color:var(--text-2);display:block;margin-bottom:4px">Discount value</label>
          <div style="display:flex;align-items:center;gap:8px">
            <input id="sale-value" type="number" class="form-input" placeholder="20" min="1" max="99" style="width:100px">
            <span id="sale-value-unit" style="color:var(--text-2);font-size:13px">%</span>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div>
            <label style="font-size:12px;font-weight:600;color:var(--text-2);display:block;margin-bottom:4px">Start date</label>
            <input id="sale-start" type="date" class="form-input" value="${today}" style="width:100%;box-sizing:border-box">
          </div>
          <div>
            <label style="font-size:12px;font-weight:600;color:var(--text-2);display:block;margin-bottom:4px">End date <span style="font-weight:400;color:var(--text-3)">(optional)</span></label>
            <input id="sale-end" type="date" class="form-input" value="${nextWeek}" style="width:100%;box-sizing:border-box">
          </div>
        </div>

        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-2);display:block;margin-bottom:4px">Minimum quantity</label>
          <input id="sale-min-qty" type="number" class="form-input" value="1" min="1" style="width:100px">
          <div style="font-size:11px;color:var(--text-3);margin-top:4px">Minimum items buyer must purchase</div>
        </div>

        <div style="background:var(--bg-secondary);border-radius:8px;padding:12px;font-size:12px;color:var(--text-2)">
          <strong style="color:var(--text)">Note:</strong> Etsy discounts apply shop-wide. To target specific sections or listings, set the discount value and use Etsy's built-in sale targeting in your Etsy seller dashboard after creating the discount here.
        </div>
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px">
        <button class="btn btn-sm" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary btn-sm" id="sale-submit-btn" onclick="window._salesSubmit()">Create discount</button>
      </div>
    </div>`);

  window._salesTypeChange = (type) => {
    const row = document.getElementById('sale-value-row');
    const unit = document.getElementById('sale-value-unit');
    if (type === 'free_shipping') {
      row.style.display = 'none';
    } else {
      row.style.display = '';
      unit.textContent = type === 'fixed_amount' ? '$' : '%';
      const valInput = document.getElementById('sale-value');
      if (valInput) valInput.placeholder = type === 'fixed_amount' ? '5.00' : '20';
    }
  };

  window._salesSubmit = async () => {
    const name = document.getElementById('sale-name')?.value?.trim();
    const type = document.getElementById('sale-type')?.value;
    const value = document.getElementById('sale-value')?.value;
    const start = document.getElementById('sale-start')?.value;
    const end = document.getElementById('sale-end')?.value;
    const minQty = document.getElementById('sale-min-qty')?.value;

    if (!name) { toastError('Enter a discount name'); return; }
    if (type !== 'free_shipping' && !value) { toastError('Enter a discount value'); return; }
    if (!start) { toastError('Select a start date'); return; }

    const btn = document.getElementById('sale-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

    try {
      const payload = {
        discount_name: name,
        discount_type: type,
        start_date: Math.floor(new Date(start).getTime() / 1000),
        min_order_quantity_type: 'listing_quantity',
        min_order_quantity: parseInt(minQty) || 1,
        seller_active: true,
      };
      if (end) payload.end_date = Math.floor(new Date(end + 'T23:59:59').getTime() / 1000);
      if (type === 'percent') payload.discount_value = parseFloat(value);
      else if (type === 'fixed_amount') payload.discount_value = Math.round(parseFloat(value) * 100);

      await etsy.createDiscount(payload);
      closeModal();
      toastSuccess('Discount created!');
      await loadDiscounts(true);
    } catch (e) {
      toastError('Failed: ' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Create discount'; }
    }
  };
}

async function deleteDiscount(id) {
  if (!confirm('Delete this discount?')) return;
  try {
    await etsy.deleteDiscount(id);
    toastSuccess('Discount deleted');
    state.discounts = state.discounts.filter(d => d.discount_id !== id);
    renderDiscountList();
    renderCalendar();
  } catch (e) {
    toastError('Delete failed: ' + e.message);
  }
}

async function toggleDiscount(id, active) {
  try {
    await etsy.updateDiscount(id, { seller_active: active });
    const d = state.discounts.find(d => d.discount_id === id);
    if (d) d.seller_active = active;
    toastSuccess(active ? 'Discount resumed' : 'Discount paused');
    renderDiscountList();
    renderCalendar();
  } catch (e) {
    toastError('Update failed: ' + e.message);
  }
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function trashIcon() { return `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 10h8l1-10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }
function pauseIcon() { return `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="3" y="2" width="4" height="12" rx="1" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="2" width="4" height="12" rx="1" stroke="currentColor" stroke-width="1.4"/></svg>`; }
function playIcon() { return `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 2l10 6-10 6V2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`; }
