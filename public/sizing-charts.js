/* Sizing Charts - standalone master-data page (part of "Product Information").
 * Reuses the .om-panel/.om-panel-backdrop modal styles from order-management.css
 * for the create/edit form, but is otherwise self-contained.
 */

function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.style.background = isError ? 'var(--jc-fail)' : 'var(--jc-teal-dark)';
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

async function api(path, opts) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

async function loadCharts() {
  const root = document.getElementById('scRoot');
  root.innerHTML = `<div class="om-empty">Loading...</div>`;
  try {
    const data = await api('/api/sizing-charts');
    renderList(data.charts || []);
  } catch (e) { showToast(e.message, true); }
}

function renderList(charts) {
  const root = document.getElementById('scRoot');
  root.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h2 class="om-view-title" style="margin:0;">Sizing Charts</h2>
      <button class="btn btn-primary" id="scNewBtn" style="flex:none;width:auto;padding:10px 18px;">+ New sizing chart</button>
    </div>
    ${charts.length ? `
      <div class="om-tile-grid">
        ${charts.map((c) => `
          <div class="om-tile" data-id="${escapeHtml(c.id)}">
            <div class="om-tile-title">${escapeHtml(c.name)}</div>
            <div class="om-tile-desc">${escapeHtml(c.productLine)} &middot; ${c.sizes.length} size${c.sizes.length === 1 ? '' : 's'}</div>
          </div>
        `).join('')}
      </div>
    ` : `<div class="om-empty">No sizing charts yet. Click "New sizing chart" to add your first standard.</div>`}
  `;
  document.getElementById('scNewBtn').addEventListener('click', () => openChartForm(null));
  root.querySelectorAll('.om-tile').forEach((tile) => {
    tile.addEventListener('click', async () => {
      try {
        const data = await api(`/api/sizing-charts/${encodeURIComponent(tile.dataset.id)}`);
        openChartForm(data.chart);
      } catch (e) { showToast(e.message, true); }
    });
  });
}

let rowCount = 0;

function sizeRowHtml(idx, data) {
  data = data || {};
  return `
    <div class="om-repeat-row" data-size-row="${idx}">
      <input type="text" placeholder="Size (e.g. Adult M)" class="sc-size" value="${escapeHtml(data.size || '')}" />
      <input type="text" placeholder="Measurement / notes" class="sc-measurement" value="${escapeHtml(data.measurement || '')}" />
      <button type="button" class="om-row-remove" data-remove-size="${idx}">&times;</button>
    </div>
  `;
}

function openChartForm(chart) {
  rowCount = 0;
  const panel = document.createElement('div');
  panel.className = 'om-panel';
  panel.innerHTML = `
   <div class="om-panel-inner">
    <div class="om-panel-header">
      <div style="font-size:19px;font-weight:700;">${chart ? 'Edit sizing chart' : 'New sizing chart'}</div>
      <button class="om-panel-close" id="scClose">&times;</button>
    </div>
    <div class="om-field-grid">
      <div><label>Chart name</label><input id="scName" type="text" value="${escapeHtml(chart && chart.name)}" placeholder="e.g. Adult Unisex Tee" /></div>
      <div><label>Product line</label>
        <select id="scProductLine">
          <option value="clothing" ${chart && chart.productLine === 'clothing' ? 'selected' : ''}>Apparel</option>
          <option value="toys" ${!chart || chart.productLine === 'toys' ? 'selected' : ''}>Toys</option>
          <option value="other" ${chart && chart.productLine === 'other' ? 'selected' : ''}>Other</option>
        </select>
      </div>
    </div>
    <div class="om-field-grid" style="margin-top:10px;">
      <div style="grid-column:1/-1;"><label>Notes</label><input id="scNotes" type="text" value="${escapeHtml(chart && chart.notes)}" /></div>
    </div>

    <div class="om-section-title">Sizes</div>
    <div id="scRows"></div>
    <button type="button" class="btn btn-secondary" id="scAddRow" style="flex:none;width:auto;padding:8px 14px;margin-top:6px;">+ Add size</button>

    <div style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap;">
      <button class="btn btn-secondary" id="scCancel" style="flex:none;width:auto;padding:10px 18px;">Cancel</button>
      ${chart ? `<button class="btn btn-secondary" id="scDelete" style="flex:none;width:auto;padding:10px 18px;color:var(--jc-fail);">Delete</button>` : ''}
      <button class="btn btn-primary" id="scSave" style="flex:none;width:auto;padding:10px 18px;">${chart ? 'Save changes' : 'Create chart'}</button>
    </div>
   </div>
  `;
  const backdrop = document.createElement('div');
  backdrop.className = 'om-panel-backdrop';
  backdrop.appendChild(panel);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closePanel(); });
  document.body.appendChild(backdrop);

  function closePanel() { backdrop.remove(); }
  document.getElementById('scClose').addEventListener('click', closePanel);
  document.getElementById('scCancel').addEventListener('click', closePanel);

  const rowsHost = document.getElementById('scRows');
  function addRow(data) {
    rowsHost.insertAdjacentHTML('beforeend', sizeRowHtml(rowCount, data));
    const idx = rowCount;
    panel.querySelector(`[data-remove-size="${idx}"]`).addEventListener('click', () => {
      panel.querySelector(`[data-size-row="${idx}"]`).remove();
    });
    rowCount++;
  }
  document.getElementById('scAddRow').addEventListener('click', () => addRow());
  if (chart && chart.sizes.length) chart.sizes.forEach(addRow);
  else addRow();

  if (chart) {
    document.getElementById('scDelete').addEventListener('click', async () => {
      if (!confirm(`Delete "${chart.name}"? This can't be undone.`)) return;
      try {
        await api(`/api/sizing-charts/${encodeURIComponent(chart.id)}`, { method: 'DELETE' });
        showToast('Sizing chart deleted');
        closePanel();
        loadCharts();
      } catch (e) { showToast(e.message, true); }
    });
  }

  document.getElementById('scSave').addEventListener('click', async () => {
    const name = document.getElementById('scName').value.trim();
    if (!name) return showToast('Chart name is required', true);
    const payload = {
      name,
      productLine: document.getElementById('scProductLine').value,
      notes: document.getElementById('scNotes').value,
      sizes: Array.from(rowsHost.querySelectorAll('[data-size-row]')).map((row) => ({
        size: row.querySelector('.sc-size').value,
        measurement: row.querySelector('.sc-measurement').value
      })).filter((s) => s.size || s.measurement)
    };
    try {
      if (chart) {
        await api(`/api/sizing-charts/${encodeURIComponent(chart.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
        showToast('Sizing chart updated');
      } else {
        await api('/api/sizing-charts', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Sizing chart created');
      }
      closePanel();
      loadCharts();
    } catch (e) { showToast(e.message, true); }
  });
}

loadCharts();
