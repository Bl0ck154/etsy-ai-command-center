// public/components/variations.js
// Etsy variations (property + options) and inventory/pricing manager

import { toastError } from './toast.js';
import { variationPriceSummary } from '../utils/listing-readiness.js';
import {
  customVariationPropertyId,
  draftVariationsToInventoryPayload,
  newVariationOptionId,
  normalizeDraftVariations,
  variationOptionKey,
  variationPricePropertyIds,
} from '../utils/etsy-variations.js';

// These are user-facing labels. New values use Etsy's custom variation slots;
// taxonomy-specific property IDs must only come from Etsy taxonomy data.
const COMMON_PROPERTIES = [
  'Color',
  'Size',
  'Material',
  'Style',
  'Finish',
  'Length',
  'Width',
  'Scent',
  'Custom label',
];

export class VariationsManager {
  constructor(containerId, { onChange = null, inventoryContainerId = null } = {}) {
    this.containerId          = containerId;
    this.inventoryContainerId = inventoryContainerId;
    this.onChange             = onChange;
    // properties: [{ property_id, name, options: [{value_id, name}] }]
    this.properties  = [];
    // products: [{ sku, price, quantity, offerings: [{property_id, value_id}] }]
    this.products    = [];
    this.enabled     = false;
    this.priceOnProperty = [];
  }

  render() {
    const el = document.getElementById(this.containerId);
    if (!el) return;

    el.innerHTML = `
      <div class="var-manager">
        <div class="var-manager-header">
          <div>
            <div class="var-manager-title">Variations</div>
            <div class="text-sm text-muted">Offer buyer choices and set prices for each combination</div>
          </div>
          <div class="toggle ${this.enabled ? 'on' : ''}" id="var-toggle" onclick="window['__varMgr_${this.containerId}'].toggleEnabled()"></div>
        </div>
        <div id="var-content" style="display:${this.enabled ? 'block' : 'none'}">
          <div id="var-properties"></div>
          <button class="btn btn-sm var-add-property" onclick="window['__varMgr_${this.containerId}'].addProperty()" ${this.properties.length >= 2 ? 'disabled' : ''}>
            + Add variation type ${this.properties.length > 0 ? `(${2 - this.properties.length} more)` : ''}
          </button>
          ${this.inventoryContainerId ? '' : '<div id="var-inventory" style="margin-top:16px"></div>'}
        </div>
      </div>`;

    if (!window.__varMgr) window.__varMgr = {};
    window[`__varMgr_${this.containerId}`] = this;

    this.renderProperties();
    this.renderInventory();
  }

  toggleEnabled() {
    this.enabled = !this.enabled;
    document.getElementById('var-toggle')?.classList.toggle('on', this.enabled);
    const content = document.getElementById('var-content');
    if (content) content.style.display = this.enabled ? 'block' : 'none';
    this._syncInventoryOuter();
    this.notify();
  }

  _syncInventoryOuter() {
    if (!this.inventoryContainerId) return;
    const outer = document.getElementById(this.inventoryContainerId);
    if (outer) outer.style.display = (this.enabled && this.products.length) ? 'block' : 'none';
  }

  addProperty() {
    if (this.properties.length >= 2) return;
    this.properties.push({
      property_id: customVariationPropertyId(this.properties.length),
      source: 'custom',
      name: '',
      options: [],
    });
    this.renderProperties();
    this.rebuildInventory();
  }

  removeProperty(index) {
    this.properties.splice(index, 1);
    this.properties.forEach((property, propertyIndex) => {
      if ([100, 101, 513, 514].includes(Number(property.property_id))) {
        property.property_id = customVariationPropertyId(propertyIndex);
      }
    });
    this.renderProperties();
    this.rebuildInventory();
  }

  setPropertyName(index, name) {
    this.properties[index].name = name;
    this.properties[index].property_id = customVariationPropertyId(index);
    this.properties[index].source = 'custom';
    this.rebuildInventory();
  }

  addOption(propIndex) {
    const valEl = document.getElementById(`prop-${this.containerId}-${propIndex}-newoption`);
    const val = valEl?.value?.trim();
    if (!val) return;
    if (this.properties[propIndex].options.some(o => o.name === val)) {
      toastError('Option already exists'); return;
    }
    this.properties[propIndex].options.push({
      value_id: null,
      client_id: newVariationOptionId(propIndex, this.properties[propIndex].options.length),
      name: val,
    });
    if (valEl) valEl.value = '';
    this.renderProperties();
    this.rebuildInventory();
  }

  removeOption(propIndex, optIndex) {
    this.properties[propIndex].options.splice(optIndex, 1);
    this.renderProperties();
    this.rebuildInventory();
  }

  renderProperties() {
    const el = document.getElementById('var-properties');
    if (!el) return;

    el.innerHTML = this.properties.map((prop, pi) => `
      <div class="var-prop-card">
        <div class="var-prop-header">
          <div class="var-prop-title">Variation ${pi + 1}</div>
          <button class="btn btn-sm btn-danger" onclick="window['__varMgr_${this.containerId}'].removeProperty(${pi})">Remove</button>
        </div>
        <div class="var-prop-fields">
          <div class="field var-prop-type">
            <label>Option type</label>
            <select onchange="window['__varMgr_${this.containerId}'].setPropertyName(${pi}, this.value)">
              <option value="">Select type...</option>
              ${COMMON_PROPERTIES.filter(name => name !== 'Custom label').map(name => `<option value="${name}" ${prop.name === name ? 'selected' : ''}>${name}</option>`).join('')}
              <option value="Custom label" ${prop.name === 'Custom label' ? 'selected' : ''}>Custom...</option>
            </select>
          </div>
          ${prop.name === 'Custom label' || !COMMON_PROPERTIES.includes(prop.name) ? `
            <div class="field var-prop-name">
              <label>Buyer-facing name</label>
              <input type="text" placeholder="Variation name" value="${escHtml(prop.name)}"
                oninput="window['__varMgr_${this.containerId}'].properties[${pi}].name=this.value"
                onblur="window['__varMgr_${this.containerId}'].rebuildInventory()">
            </div>` : ''}
        </div>

        <div class="var-options-label">Options</div>
        <div class="var-options-wrap" id="prop-${this.containerId}-${pi}-options">
          ${prop.options.map((opt, oi) => `
            <span class="tag-chip">
              ${escHtml(opt.name)}
              <button class="tag-chip-remove" onclick="window['__varMgr_${this.containerId}'].removeOption(${pi}, ${oi})">×</button>
            </span>`).join('')}
        </div>

        <div class="var-option-add">
          <input type="text" id="prop-${this.containerId}-${pi}-newoption" placeholder="Add option..."
            onkeydown="if(event.key==='Enter'){event.preventDefault();window['__varMgr_${this.containerId}'].addOption(${pi})}">
          <button class="btn btn-sm" onclick="window['__varMgr_${this.containerId}'].addOption(${pi})">Add</button>
        </div>
      </div>`).join('');
  }

  rebuildInventory() {
    // Generate all combinations
    if (!this.properties.length || this.properties.some(p => !p.options.length)) {
      this.products = [];
      this.renderInventory();
      this.notify();
      return;
    }

    const combos = cartesian(this.properties.map(p => p.options));
    const existing = new Map(this.products.map(p => [
      (p.offerings || []).map(o => o.option_id || o.value_id).sort().join('-'),
      p,
    ]));

    this.products = combos.map(combo => {
      const offerings = combo.map((opt, i) => ({
        property_id: this.properties[i].property_id,
        option_id: variationOptionKey(opt),
        value_id: opt.value_id || null,
      }));
      const key = offerings.map(o => o.option_id || o.value_id).sort().join('-');
      const prev = existing.get(key);
      return {
        sku: prev?.sku || '',
        price: prev?.price !== undefined ? prev.price : '',
        quantity: prev?.quantity !== undefined ? prev.quantity : 999,
        offerings,
        is_enabled: prev?.is_enabled !== false,
      };
    });

    this.priceOnProperty = variationPricePropertyIds(this.properties, this.products);

    this.renderInventory();
    this.notify();
  }

  updateProduct(index, field, value) {
    if (!this.products[index]) return;
    if (field === 'price') this.products[index].price = value;
    if (field === 'quantity') this.products[index].quantity = parseInt(value) || 0;
    if (field === 'sku') this.products[index].sku = value;
    if (field === 'enabled') this.products[index].is_enabled = value;
    this.notify();
  }

  bulkSetPrice(price) {
    const p = parseFloat(price);
    if (isNaN(p)) return;
    this.products.forEach(prod => { prod.price = p; });
    this.renderInventory();
    this.notify();
  }

  bulkSetQty(qty) {
    const q = parseInt(qty);
    if (isNaN(q)) return;
    this.products.forEach(prod => { prod.quantity = q; });
    this.renderInventory();
    this.notify();
  }

  renderInventory() {
    const invId = this.inventoryContainerId || 'var-inventory';
    const el = document.getElementById(invId);
    if (!el) return;
    if (!this.products.length) { el.innerHTML = ''; this._syncInventoryOuter(); return; }

    const headers = this.properties.map(p => p.name || 'Option');

    this.priceOnProperty = variationPricePropertyIds(this.properties, this.products);
    el.innerHTML = `
      <div class="var-inventory-section">
      <div class="var-inventory-heading">
        <div>
          <div class="var-inventory-title">Inventory & pricing</div>
          <div class="text-sm text-muted">${this.products.length} combination${this.products.length !== 1 ? 's' : ''}; each price is the final buyer price</div>
        </div>
      </div>

      <div class="var-bulk-toolbar">
        <span class="text-sm text-muted var-bulk-label">Set all</span>
        <div class="var-bulk-control">
          <span class="input-prefix-text" style="padding:5px 8px;font-size:12px;background:var(--bg-hover);border:1px solid var(--border);border-right:none;border-radius:var(--radius) 0 0 var(--radius)">$</span>
          <input type="number" id="bulk-price-input" placeholder="Price" step="0.01" min="0.20" style="width:90px;border-radius:0 var(--radius) var(--radius) 0;padding:5px 8px;font-size:12px">
          <button class="btn btn-sm" onclick="window['__varMgr_${this.containerId}'].bulkSetPrice(document.getElementById('bulk-price-input').value)">Set all prices</button>
        </div>
        <div class="var-bulk-control">
          <input type="number" id="bulk-qty-input" placeholder="Qty" min="0" style="width:80px;padding:5px 8px;font-size:12px">
          <button class="btn btn-sm" onclick="window['__varMgr_${this.containerId}'].bulkSetQty(document.getElementById('bulk-qty-input').value)">Set all quantities</button>
        </div>
      </div>

      <div class="table-wrap">
        <table>
          <thead><tr>
            <th style="width:30px"><input type="checkbox" onchange="document.querySelectorAll('.var-row-check').forEach(c=>{c.checked=this.checked;window['__varMgr_${this.containerId}'].updateProduct(parseInt(c.dataset.idx),'enabled',this.checked)})" checked></th>
            ${headers.map(h => `<th>${escHtml(h)}</th>`).join('')}
            <th style="width:110px">Price ($)</th>
            <th style="width:80px">Quantity</th>
            <th style="width:110px">SKU</th>
          </tr></thead>
          <tbody>
            ${this.products.map((prod, idx) => {
              const labels = prod.offerings.map(o => {
                const prop = this.properties.find(p => p.property_id === o.property_id);
                const optionKey = String(o.option_id || o.value_id || '');
                const opt = prop?.options.find(option => variationOptionKey(option) === optionKey);
                return opt?.name || '—';
              });
              return `<tr style="${prod.is_enabled ? '' : 'opacity:0.5'}">
                <td><input type="checkbox" class="var-row-check" data-idx="${idx}" ${prod.is_enabled ? 'checked' : ''}
                  onchange="window['__varMgr_${this.containerId}'].updateProduct(${idx},'enabled',this.checked)"></td>
                ${labels.map(l => `<td style="font-size:12px;font-weight:500">${escHtml(l)}</td>`).join('')}
                <td><input type="text" inputmode="decimal" value="${prod.price || ''}" placeholder="—"
                  style="width:100%;padding:4px 6px;font-size:12px"
                  oninput="this.value=this.value.replace(/[^0-9.]/g,'');window['__varMgr_${this.containerId}'].updateProduct(${idx},'price',this.value)"></td>
                <td><input type="number" min="0" value="${prod.quantity}" placeholder="999"
                  style="width:100%;padding:4px 6px;font-size:12px"
                  oninput="window['__varMgr_${this.containerId}'].updateProduct(${idx},'quantity',this.value)"></td>
                <td><input type="text" value="${escHtml(prod.sku || '')}" placeholder="Optional"
                  style="width:100%;padding:4px 6px;font-size:12px"
                  oninput="window['__varMgr_${this.containerId}'].updateProduct(${idx},'sku',this.value)"></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div id="var-validation-${this.containerId}" class="var-validation-message" role="status"></div>
      </div>`;
    this._syncInventoryOuter();
    this._renderValidation();
  }

  _renderValidation() {
    const element = document.getElementById(`var-validation-${this.containerId}`);
    if (!element) return;
    const errors = this.getValidationErrors();
    element.textContent = errors[0] || '';
    element.classList.toggle('is-visible', errors.length > 0);
  }

  notify() {
    this.priceOnProperty = variationPricePropertyIds(this.properties, this.products);
    this._renderValidation();
    if (this.onChange) this.onChange({
      enabled: this.enabled,
      products: this.products,
      priceSummary: this.getPriceSummary(),
      errors: this.getValidationErrors(),
    });
  }

  getPriceSummary() {
    return variationPriceSummary(this.products);
  }

  getValidationErrors() {
    if (!this.enabled) return [];
    if (!this.properties.length) return ['Add at least one variation type.'];
    if (this.properties.some(property => !property.name || !property.options?.length)) {
      return ['Every variation type needs a name and at least one option.'];
    }
    const summary = this.getPriceSummary();
    if (!summary.enabledCount) return ['Enable at least one variation combination.'];
    if (summary.invalidIndexes.length) {
      return [`Set a final price of at least $0.20 for every enabled variation (${summary.invalidIndexes.length} missing).`];
    }
    return [];
  }

  getInventoryPayload(readinessStateId = null) {
    if (!this.enabled || !this.products.length) return null;
    const errors = this.getValidationErrors();
    if (errors.length) throw new Error(errors[0]);
    return draftVariationsToInventoryPayload({ enabled: this.enabled, properties: this.properties, products: this.products }, readinessStateId);
  }

  loadDraft(variations = {}) {
    const normalized = normalizeDraftVariations(variations);
    this.enabled = normalized.enabled;
    this.properties = normalized.properties;
    this.products = normalized.products;
    this.priceOnProperty = normalized.priceOnProperty;
    this.render();
  }

  loadFromEtsy(inventory) {
    if (!inventory?.products?.length) return;
    this.enabled = true;

    // Rebuild properties from existing data
    const propMap = new Map();
    for (const product of inventory.products) {
      for (const pv of product.property_values || []) {
        if (!propMap.has(pv.property_id)) {
          propMap.set(pv.property_id, { property_id: pv.property_id, source: 'etsy', name: pv.property_name, scale_id: pv.scale_id ?? null, options: [] });
        }
        const prop = propMap.get(pv.property_id);
        for (let i = 0; i < pv.value_ids.length; i++) {
          const vid = pv.value_ids[i];
          const vname = pv.values?.[i] || String(vid);
          if (!prop.options.some(o => o.value_id === vid)) {
            prop.options.push({ value_id: vid, client_id: `etsy-${vid}`, name: vname });
          }
        }
      }
    }
    this.properties = [...propMap.values()];

    this.products = inventory.products.map(p => ({
      sku: p.sku || '',
      price: (p.offerings?.[0]?.price?.amount || 0) / (p.offerings?.[0]?.price?.divisor || 100),
      quantity: p.offerings?.[0]?.quantity || 0,
      is_enabled: p.offerings?.[0]?.is_enabled !== false,
      offerings: (p.property_values || []).map(pv => ({
        property_id: pv.property_id,
        option_id: `etsy-${pv.value_ids?.[0]}`,
        value_id: pv.value_ids?.[0],
      })),
    }));

    this.priceOnProperty = inventory.price_on_property || [];
    this.render();
  }
}

// ── Helpers ───────────────────────────────────────────────

function cartesian(arrays) {
  return arrays.reduce((acc, arr) =>
    acc.flatMap(combo => arr.map(item => [...combo, item])),
    [[]]
  );
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── CSS ───────────────────────────────────────────────────
const style = document.createElement('style');
style.textContent = `
.var-manager { min-width: 0; }
.var-manager-header,
.var-prop-header,
.var-inventory-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.var-manager-header { margin-bottom: 14px; }
.var-manager-title,
.var-inventory-title { color: var(--text); font-size: 13px; font-weight: 700; }
.var-prop-card {
  padding: 14px 0;
  border-top: 1px solid var(--border);
}
.var-prop-title,
.var-options-label { color: var(--text-2); font-size: 11px; font-weight: 700; }
.var-prop-fields { display: grid; grid-template-columns: minmax(180px, 0.7fr) minmax(240px, 1.3fr); gap: 12px; margin-top: 12px; }
.var-prop-fields .field { margin-bottom: 10px; }
.var-options-label { margin-bottom: 6px; }
.var-options-wrap {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 38px;
  padding: 7px 8px; background: var(--bg-secondary);
  border: 1px solid var(--border); border-radius: 6px;
}
.var-option-add { display: grid; grid-template-columns: minmax(180px, 320px) auto; gap: 8px; justify-content: start; margin-top: 8px; }
.var-add-property { margin-top: 10px; }
.var-inventory-section { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--border); }
.var-bulk-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; margin: 12px 0; padding: 10px; border-radius: 6px; background: var(--bg-secondary); }
.var-bulk-control { display: flex; align-items: center; gap: 4px; }
.var-inventory-section .table-wrap { margin-top: 10px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
.var-inventory-section table { min-width: 650px; }
@media (max-width: 720px) {
  .var-prop-fields { grid-template-columns: 1fr; gap: 0; }
  .var-option-add { grid-template-columns: minmax(0, 1fr) auto; }
  .var-bulk-label { width: 100%; }
  .var-bulk-control { width: 100%; }
  .var-bulk-control input { min-width: 0; flex: 1; width: auto !important; }
}
`;
document.head.appendChild(style);
