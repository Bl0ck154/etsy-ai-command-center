import { actionCardState, wireActionCard } from './action-card.js';
import {
  draftVariationPriceRows,
  variationOptionPricingAmount,
  variationPropertyPricingMode,
} from './etsy-variations.js';

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function summarizeVariationProducts(products) {
  const map = new Map();
  for (const product of products || []) {
    for (const propertyValue of product.property_values || []) {
      const key = propertyValue.property_id || propertyValue.property_name || map.size;
      if (!map.has(key)) {
        map.set(key, { name: propertyValue.property_name || 'Variation', options: [] });
      }
      const item = map.get(key);
      for (const value of propertyValue.values || []) {
        const text = String(value || '').trim();
        if (text && !item.options.includes(text)) item.options.push(text);
      }
    }
  }
  return [...map.values()];
}

export function createAgentVariationCardView({
  cancelPendingCard,
  listingThumbHtml,
  listingLinkHtml,
  agentNoticeHtml,
} = {}) {
  const renderVariationsCard = (data, onApply, options = {}) => {
    const el = document.createElement('div');
    el.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:8px 0';
    const isEtsyListing = data.target_type === 'etsy_listing' && Number(data.listing_id) > 0;
    const targetHtml = isEtsyListing ? `
      <div style="font-size:12px;color:var(--text-2);margin-bottom:8px">
        <strong>${escHtml(data.listing_title || `Listing ${data.listing_id}`)}</strong>
        <span style="color:var(--text-3)"> · ID ${escHtml(data.listing_id)}</span>
      </div>` : '';

    const ltypeLine = data.listing_type
      ? `<div style="font-size:12px;color:var(--text-2);margin-bottom:6px">Listing type → <strong>${data.listing_type}</strong></div>`
      : '';
    const propsHtml = (data.properties || []).map((property, propertyIndex) => {
      const pricingMode = variationPropertyPricingMode(property, propertyIndex);
      return `<div style="font-size:12px;margin-bottom:4px"><strong>${escHtml(property.name)}${pricingMode === 'surcharge' ? ' surcharge' : ''}</strong>: ${(property.options || []).map(rawOption => {
        const option = typeof rawOption === 'string' ? { name: rawOption } : rawOption;
        const amount = variationOptionPricingAmount(property, option, propertyIndex);
        const pricing = Number.isFinite(Number(amount))
          ? ` · ${pricingMode === 'surcharge' ? '+' : ''}$${Number(amount).toFixed(2)}`
          : '';
        return `<span style="background:var(--bg-card);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-size:11px">${escHtml(option.name || String(rawOption))}${pricing}</span>`;
      }).join(' ')}</div>`;
    }).join('');
    const priceRows = data.properties?.length ? draftVariationPriceRows(data) : [];
    const priceMatrixHtml = priceRows.length ? `
      <details style="margin-top:9px" open>
        <summary style="font-size:11px;font-weight:700;color:var(--text-2);cursor:pointer">Final prices sent to Etsy · ${priceRows.length} combinations</summary>
        <div style="max-height:220px;overflow:auto;margin-top:6px">
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            <tbody>${priceRows.map(row => `<tr><td style="padding:4px 6px;border-bottom:1px solid var(--border)">${escHtml(row.label)}</td><td style="padding:4px 6px;border-bottom:1px solid var(--border);text-align:right;font-weight:700;white-space:nowrap">$${row.price.toFixed(2)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </details>` : '';
    const setupHtml = data.listing_type === 'physical' ? `
      <div style="display:grid;gap:3px;margin:8px 0;padding:8px 10px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;font-size:11px;color:var(--text-2)">
        <div><strong>Starting price:</strong> ${Number(data.base_price) >= 0.20 ? `$${Number(data.base_price).toFixed(2)}` : 'Needs attention'}</div>
        <div><strong>Category:</strong> ${escHtml(data.taxonomy_category || (Number(data.taxonomy_id) > 0 ? 'Keep current listing category' : 'Needs attention'))}</div>
        <div><strong>Shipping:</strong> ${Number(data.shipping_profile_id) > 0 ? 'Keep current listing profile' : 'Needs attention'}</div>
        <div><strong>Processing:</strong> ${Number(data.readiness_state_id) > 0 ? 'Keep current listing profile' : 'Needs attention'}</div>
      </div>` : '';
    const questionsHtml = Array.isArray(data.personalization_questions) && data.personalization_questions.length ? `
      <div style="margin-top:10px;padding-top:9px;border-top:1px solid var(--border)">
        <div style="font-size:11px;font-weight:700;color:var(--text-2);margin-bottom:5px">Personalization</div>
        ${data.personalization_questions.map(question => `<div style="font-size:12px;margin:3px 0"><strong>${escHtml(question.question_text)}</strong>${question.required ? ' · Required' : ''}</div>`).join('')}
      </div>` : '';

    el.innerHTML = `
      <div style="font-weight:700;font-size:13px;margin-bottom:8px">${isEtsyListing ? 'Listing options update' : 'Listing draft options'}</div>
      ${targetHtml}
      ${ltypeLine}
      ${setupHtml}
      ${propsHtml}
      ${priceMatrixHtml}
      ${questionsHtml}
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn btn-primary btn-sm" id="var-apply-btn">${isEtsyListing ? 'Apply to Etsy listing' : 'Apply to listing draft'}</button>
        <button class="btn btn-sm" id="var-cancel-btn" style="color:var(--text-3)">✕ Cancel</button>
      </div>
      <div id="var-progress" role="status" style="font-size:12px;color:var(--text-2);margin-top:8px"></div>
      <div id="var-result-actions" style="display:none;flex-wrap:wrap;gap:8px;margin-top:9px">
        <button class="btn btn-sm" id="var-verify-btn">Verify changes</button>
        <button class="btn btn-sm" id="var-open-editor-btn">Open in Etsy AI Command Center</button>
      </div>`;

    wireActionCard(el, {
      approveSelector: '#var-apply-btn',
      cancelSelector: '#var-cancel-btn',
      progressSelector: '#var-progress',
      onApprove: () => onApply(data, el),
      onCancel: () => {
        cancelPendingCard(el, data._messageIndex, 'pending_variations', ['#var-apply-btn', '#var-cancel-btn']);
      },
    }, options);
    return el;
  };

  const renderClearVariationsCard = (plan, onApprove, onCancel, options = {}) => {
    const el = document.createElement('div');
    el.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:8px 0';
    const disabled = actionCardState(options).disabled;
    const rows = (plan.listings || []).map(item => {
      const props = (item.summary?.properties || []).map(property => `${escHtml(property.name)}: ${escHtml((property.options || []).join(', '))}`).join('<br>');
      const priceRange = item.summary?.price_min != null
        ? `$${item.summary.price_min}${item.summary.price_max !== item.summary.price_min ? `-$${item.summary.price_max}` : ''}`
        : 'unknown';
      return `<tr>
        <td>${escHtml(item.listing_title || item.listing_id)}</td>
        <td>${item.summary?.product_count || 0}</td>
        <td>${props || 'No variation properties'}</td>
        <td>${priceRange}</td>
      </tr>`;
    }).join('');

    el.innerHTML = `
      <div style="font-weight:700;font-size:13px;margin-bottom:8px">Remove Variations</div>
      <div style="font-size:12px;color:var(--text-2);margin-bottom:8px">${escHtml(plan.summary || 'Remove listing variations')}</div>
      <div style="overflow:auto;margin-bottom:10px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr><th style="text-align:left">Listing</th><th>Products</th><th style="text-align:left">Current variations</th><th>Current prices</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="font-size:12px;color:var(--text-2);margin-bottom:10px">Approval will remove variation properties and keep a single inventory row using the saved snapshot fallback price/quantity.</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" id="clear-var-approve-btn" ${disabled ? 'disabled' : ''}>${disabled ? 'Expired' : 'Approve'}</button>
        <button class="btn btn-sm" id="clear-var-cancel-btn" style="color:var(--text-3)" ${disabled ? 'disabled' : ''}>Cancel</button>
      </div>
      <div id="clear-var-progress" style="font-size:12px;color:var(--text-2);margin-top:8px"></div>`;

    wireActionCard(el, {
      approveSelector: '#clear-var-approve-btn',
      cancelSelector: '#clear-var-cancel-btn',
      progressSelector: '#clear-var-progress',
      onApprove: () => onApprove(plan, el),
      onCancel: () => onCancel(el),
    }, options);
    return el;
  };

  const renderRemoveVariationPropertyCard = (plan, onApprove, onCancel, options = {}) => {
    const el = document.createElement('div');
    el.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:8px 0';
    const disabled = actionCardState(options).disabled;
    const rows = (plan.listings || []).map(item => {
      const before = (item.summary?.properties || []).map(property => `${escHtml(property.name)}: ${escHtml((property.options || []).join(', '))}`).join('<br>');
      const afterSummary = item.remaining_summary?.length
        ? item.remaining_summary
        : summarizeVariationProducts(item.update_to?.products || []);
      const afterProps = afterSummary.map(property => `${escHtml(property.name || 'Variation')}: ${escHtml((property.options || []).join(', '))}`).join('<br>') || 'Single inventory row';
      return `<tr>
        <td>${escHtml(item.listing_title || item.listing_id)}</td>
        <td>${before || 'No variations'}</td>
        <td>${escHtml(item.removed_property?.name || plan.property_name || 'Variation')}</td>
        <td>${afterProps}</td>
      </tr>`;
    }).join('');

    el.innerHTML = `
      <div style="font-weight:700;font-size:13px;margin-bottom:8px">Update Variations</div>
      <div style="font-size:12px;color:var(--text-2);margin-bottom:8px">${escHtml(plan.summary || `Remove ${plan.property_name || 'variation property'}`)}</div>
      <div style="overflow:auto;margin-bottom:10px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr><th style="text-align:left">Listing</th><th style="text-align:left">Before</th><th>Remove</th><th style="text-align:left">After</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="font-size:12px;color:var(--text-2);margin-bottom:10px">Approval removes only the selected variation property and preserves remaining variation prices/quantities from the snapshot.</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" id="remove-var-prop-approve-btn" ${disabled ? 'disabled' : ''}>${disabled ? 'Expired' : 'Approve'}</button>
        <button class="btn btn-sm" id="remove-var-prop-cancel-btn" style="color:var(--text-3)" ${disabled ? 'disabled' : ''}>Cancel</button>
      </div>
      <div id="remove-var-prop-progress" style="font-size:12px;color:var(--text-2);margin-top:8px"></div>`;

    wireActionCard(el, {
      approveSelector: '#remove-var-prop-approve-btn',
      cancelSelector: '#remove-var-prop-cancel-btn',
      progressSelector: '#remove-var-prop-progress',
      onApprove: () => onApprove(plan, el),
      onCancel: () => onCancel(el),
    }, options);
    return el;
  };

  const renderPriceMultiplierInventoryCard = (plan, onApprove, onCancel, options = {}) => {
    const el = document.createElement('div');
    el.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:8px 0';
    const disabled = actionCardState(options).disabled;
    const priceRange = summary => summary?.price_min != null
      ? `$${summary.price_min}${summary.price_max !== summary.price_min ? `-$${summary.price_max}` : ''}`
      : 'unknown';
    const rows = (plan.listings || []).map(item => {
      const props = (item.summary?.properties || []).map(property => `${escHtml(property.name)}: ${escHtml((property.options || []).join(', '))}`).join('<br>') || 'No variation properties';
      const sample = (item.changes || []).slice(0, 5).map(change => `${escHtml(change.variation || `Row ${change.index}`)}: $${escHtml(change.current_price)} → $${escHtml(change.new_price)}`).join('<br>');
      return `<tr>
        <td>${listingThumbHtml(item, 42) || ''}<div>${listingLinkHtml(item.listing_id, item.listing_title || item.listing_id, item.state || 'active')}</div><div style="font-size:11px;color:var(--text-3)">ID ${escHtml(item.listing_id)}</div></td>
        <td>${item.summary?.product_count || 0}<div style="font-size:11px;color:var(--text-3)">${props}</div></td>
        <td>${priceRange(item.summary)}</td>
        <td>${priceRange(item.new_summary)}</td>
        <td style="text-align:left">${sample || '—'}</td>
      </tr>`;
    }).join('');
    const modeText = plan.mode === 'set'
      ? (plan.value != null
        ? `This sets every inventory offering price to $${escHtml(plan.value)}`
        : 'This sets inventory offering prices to the proposed new values')
      : `This multiplies every inventory offering price by ${escHtml(plan.multiplier ?? plan.value ?? '')}x`;

    el.innerHTML = `
      <div style="font-weight:700;font-size:13px;margin-bottom:8px">Variation-safe price update</div>
      <div class="agent-preview-status-row">
        <span class="agent-preview-pill">Preview, not applied</span>
        <span class="agent-preview-pill agent-preview-pill-approval">Approval required</span>
      </div>
      ${agentNoticeHtml(`${modeText} and preserves all variation properties. Nothing changes on Etsy until approval.`, 'info')}
      <div style="font-size:12px;color:var(--text-2);margin-bottom:8px">${escHtml(plan.summary || 'Update inventory prices')}</div>
      <div style="overflow:auto;margin-bottom:10px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr><th style="text-align:left">Listing</th><th>Products / variations</th><th>Current prices</th><th>New prices</th><th style="text-align:left">Sample rows</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" id="price-mult-approve-btn" ${disabled ? 'disabled' : ''}>${disabled ? 'Expired' : 'Approve & update prices'}</button>
        <button class="btn btn-sm" id="price-mult-cancel-btn" style="color:var(--text-3)" ${disabled ? 'disabled' : ''}>Cancel</button>
      </div>
      <div id="price-mult-progress" style="font-size:12px;color:var(--text-2);margin-top:8px"></div>`;

    wireActionCard(el, {
      approveSelector: '#price-mult-approve-btn',
      cancelSelector: '#price-mult-cancel-btn',
      progressSelector: '#price-mult-progress',
      onApprove: () => onApprove(plan, el),
      onCancel: () => onCancel(el),
    }, options);
    return el;
  };

  return {
    renderVariationsCard,
    renderClearVariationsCard,
    renderRemoveVariationPropertyCard,
    renderPriceMultiplierInventoryCard,
  };
}
