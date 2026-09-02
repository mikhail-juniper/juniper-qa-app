/* Clients - merges the existing "Creators / Brands" list and "Creator Tiers"
 * mapping (both already used by the QA/QC AQL sampling recommendation logic
 * in app.js) into one table, under Product Information. Deliberately reuses
 * the existing /api/options and /api/creator-tiers endpoints rather than a
 * new store, since app.js's tier-based sampling logic already depends on
 * exactly that data shape - no reason to duplicate it.
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

let clientNames = [];
let tiers = {};
const DEFAULT_TIER = 2; // only used to seed a brand-new client's tier - never shown or editable as a global setting

async function loadClients() {
  const root = document.getElementById('clRoot');
  root.innerHTML = `<div class="om-empty">Loading...</div>`;
  try {
    const [optionsRes, tiersRes] = await Promise.all([
      fetch('/api/options'),
      fetch('/api/creator-tiers')
    ]);
    const options = await optionsRes.json();
    const tiersData = await tiersRes.json();
    clientNames = options.creators || [];
    tiers = tiersData.tiers || {};

    // Every client needs its OWN stored tier - if any are missing one
    // (falling back to the shared default), assign and persist an explicit
    // value now so it can never again drift just because someone changes
    // what new clients default to.
    let needsSave = false;
    clientNames.forEach((name) => {
      if (tiers[name] === undefined) {
        tiers[name] = DEFAULT_TIER;
        needsSave = true;
      }
    });
    if (needsSave) await saveClients(false);
    render();
  } catch (e) { showToast(e.message, true); }
}

function render() {
  const root = document.getElementById('clRoot');
  const rows = clientNames.slice().sort((a, b) => a.localeCompare(b));
  root.innerHTML = `
    <h2 class="om-view-title">Clients</h2>
    <div class="om-table-wrap">
      <table class="om-table">
        <thead><tr><th>Client / Creator / Brand</th><th>Creator Tier</th><th></th></tr></thead>
        <tbody>
          ${rows.map((name) => `
            <tr>
              <td><strong>${escapeHtml(name)}</strong></td>
              <td>
                <select data-tier-for="${escapeHtml(name)}">
                  ${[1, 2, 3].map((t) => `<option value="${t}" ${tiers[name] === t ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
              </td>
              <td><button type="button" class="om-file-remove" data-remove="${escapeHtml(name)}" title="Remove">&times;</button></td>
            </tr>
          `).join('') || `<tr><td colspan="3" class="om-empty">No clients yet.</td></tr>`}
        </tbody>
      </table>
    </div>
    <div class="om-file-upload-row" style="margin-top:14px;max-width:520px;">
      <input type="text" id="clNewName" placeholder="New client / creator / brand name..." style="flex:1 1 220px;padding:8px 12px;border-radius:var(--radius-sm);border:1.5px solid var(--jc-border);" />
      <select id="clNewTier">
        <option value="1">Tier 1</option>
        <option value="2" selected>Tier 2</option>
        <option value="3">Tier 3</option>
      </select>
      <button class="btn btn-primary" id="clAddBtn" style="flex:none;width:auto;padding:8px 16px;">+ Add client</button>
    </div>
  `;

  root.querySelectorAll('[data-tier-for]').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      tiers[sel.dataset.tierFor] = parseInt(e.target.value, 10);
      saveClients();
    });
  });
  root.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.remove;
      clientNames = clientNames.filter((n) => n !== name);
      delete tiers[name];
      saveClients();
    });
  });
  document.getElementById('clAddBtn').addEventListener('click', () => {
    const nameInput = document.getElementById('clNewName');
    const name = nameInput.value.trim();
    if (!name) return showToast('Enter a name first', true);
    if (clientNames.includes(name)) return showToast('That client already exists', true);
    clientNames.push(name);
    tiers[name] = parseInt(document.getElementById('clNewTier').value, 10);
    saveClients();
  });
}

async function saveClients(showConfirmation) {
  try {
    await Promise.all([
      fetch('/api/options', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creators: clientNames })
      }),
      fetch('/api/creator-tiers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tiers, defaultTier: DEFAULT_TIER })
      })
    ]);
    if (showConfirmation !== false) {
      showToast('Saved');
      render();
    }
  } catch (e) { showToast(e.message, true); }
}

loadClients();
