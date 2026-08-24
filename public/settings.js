/* Juniper QA/QC Report - Settings page (manage Factory Code / Creator / QA Lead lists) */

let I18N = {};
let currentOptions = { creators: [], factoryCodes: [], qaLeads: [], pointCheckRates: [] };
let dirty = false;

const LISTS = [
  { key: 'factoryCodes', labelKey: 'factoryCode', pluralEn: 'Factory Codes', pluralZh: '工厂代码' },
  { key: 'creators', labelKey: 'creator', pluralEn: 'Creators / Brands', pluralZh: '创作者 / 品牌方' },
  { key: 'qaLeads', labelKey: 'qaLead', pluralEn: 'QA/QC Leads', pluralZh: 'QA/QC 负责人' }
];

function bi(key, fallback) {
  const e = I18N[key];
  if (!e) return { en: fallback || key, zh: '' };
  return e;
}
function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  setTimeout(() => { t.className = 'toast hidden'; }, 3200);
}

async function loadEverything() {
  try {
    const [configRes, optionsRes] = await Promise.all([
      fetch('/api/config'),
      fetch('/api/options')
    ]);
    const config = await configRes.json();
    I18N = config.i18n || {};
    currentOptions = await optionsRes.json();
  } catch (e) {
    console.error(e);
    showToast('Failed to load settings / 加载设置失败', true);
  }
}

function render() {
  const root = document.getElementById('settingsRoot');
  root.innerHTML = `
    <a href="index.html" class="btn btn-secondary" style="display:inline-block;width:auto;padding:10px 18px;margin-bottom:16px;text-decoration:none;">
      ← ${escapeHtml(bi('backToApp').en)} / ${escapeHtml(bi('backToApp').zh)}
    </a>
    <div class="step-title">${escapeHtml(bi('manageDropdowns').en)}<span class="zh">${escapeHtml(bi('manageDropdowns').zh)}</span></div>
    <div class="section-help" style="margin-bottom:16px;">${escapeHtml(bi('manageDropdownsHelp').en)}<br/>${escapeHtml(bi('manageDropdownsHelp').zh)}</div>
    ${LISTS.map(renderListCard).join('')}
    <div class="nav-buttons">
      <button class="btn btn-primary" id="btnSave">${escapeHtml(bi('saveSettings').en)} / ${escapeHtml(bi('saveSettings').zh)}</button>
    </div>
  `;
  attachHandlers();
}

function renderListCard(def) {
  const items = currentOptions[def.key] || [];
  const l = bi(def.labelKey);
  const rows = items.map((item, idx) => `
    <div class="settings-item" data-list="${def.key}" data-idx="${idx}">
      <span>${escapeHtml(item)}</span>
      <button type="button" class="settings-remove" data-remove-item="${def.key}" data-idx="${idx}">✕</button>
    </div>
  `).join('');

  return `
    <div class="card">
      <div class="section-title">${escapeHtml(def.pluralEn)}<span class="zh">${escapeHtml(def.pluralZh)}</span></div>
      <div class="settings-list" id="list_${def.key}">
        ${rows || `<div class="section-help">No entries yet.</div>`}
      </div>
      <div class="field-row" style="margin-top:12px;">
        <input type="text" id="add_input_${def.key}" placeholder="${escapeHtml(l.en)}..." style="flex:1;" />
        <button type="button" class="btn btn-secondary" style="flex:0 0 auto;" data-add-item="${def.key}">
          ${escapeHtml(bi('addOption').en)} / ${escapeHtml(bi('addOption').zh)}
        </button>
      </div>
    </div>
  `;
}

function attachHandlers() {
  document.querySelectorAll('[data-remove-item]').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.getAttribute('data-remove-item');
      const idx = parseInt(el.getAttribute('data-idx'), 10);
      currentOptions[key].splice(idx, 1);
      dirty = true;
      render();
    });
  });
  document.querySelectorAll('[data-add-item]').forEach((el) => {
    el.addEventListener('click', () => addItem(el.getAttribute('data-add-item')));
  });
  LISTS.forEach((def) => {
    const input = document.getElementById(`add_input_${def.key}`);
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addItem(def.key);
        }
      });
    }
  });
  const btnSave = document.getElementById('btnSave');
  if (btnSave) btnSave.addEventListener('click', saveSettings);
}

function addItem(key) {
  const input = document.getElementById(`add_input_${key}`);
  const value = (input.value || '').trim();
  if (!value) return;
  if (currentOptions[key].includes(value)) {
    showToast('Already in the list / 已在列表中', true);
    return;
  }
  currentOptions[key].push(value);
  dirty = true;
  render();
}

async function saveSettings() {
  const btn = document.getElementById('btnSave');
  btn.disabled = true;
  const originalText = btn.innerHTML;
  btn.innerHTML = `<span class="spinner"></span>...`;
  try {
    const res = await fetch('/api/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creators: currentOptions.creators,
        factoryCodes: currentOptions.factoryCodes,
        qaLeads: currentOptions.qaLeads
      })
    });
    if (!res.ok) throw new Error('Save failed');
    dirty = false;
    showToast(bi('settingsSaved').en + ' / ' + bi('settingsSaved').zh);
  } catch (e) {
    console.error(e);
    showToast(bi('settingsSaveError').en + ' / ' + bi('settingsSaveError').zh, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

window.addEventListener('beforeunload', (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

(async function init() {
  await loadEverything();
  render();
})();
