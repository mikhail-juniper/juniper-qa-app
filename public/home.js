/* Juniper QA/QC - Home landing page: three main workstreams */

let I18N = {};

/* One active language at a time, chosen with the header toggle (see
 * i18n-shared.js). The returned shape is unchanged so every existing
 * biHtml/biBlockHtml call site still works - the secondary slot is just
 * always empty now, which makes those helpers render a single language. */
function bi(key, fallback) {
  const e = I18N[key];
  if (!e) return { en: fallback || key, zh: '' };
  const lang = (window.JuniperLang && window.JuniperLang.get()) || 'zh';
  const primary = lang === 'en' ? (e.en || e.zh) : (e.zh || e.en);
  return { en: primary || fallback || key, zh: '' };
}
function biBlockHtml(key, fallback) {
  const e = bi(key, fallback);
  if (!e.zh) return escapeHtml(e.en);
  return `${escapeHtml(e.en)}<span class="zh">${escapeHtml(e.zh)}</span>`;
}
function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const config = await res.json();
    I18N = config.i18n || {};
  } catch (e) {
    console.error('Failed to load config', e);
  }
}

function render() {
  const root = document.getElementById('homeRoot');
  root.innerHTML = `
    <div style="display:flex; justify-content:flex-end; gap:16px; margin-bottom:16px;">
      <a href="analytics.html" class="settings-link" title="Analytics">📊 ${biBlockHtml('analyticsLink', 'Analytics')}</a>
      <a href="settings.html" class="settings-link" title="Settings">⚙️ ${biBlockHtml('settingsTitle', 'Settings')}</a>
    </div>

    <div class="home-nav-card" onclick="location.href='reporting.html?mode=newPO'">
      <div class="home-nav-icon">🆕</div>
      <div class="home-nav-text">
        <div class="home-nav-title">${biBlockHtml('chooserNewPO', 'New Purchase Order')}</div>
        <div class="home-nav-desc">${biBlockHtml('chooserNewPODesc', 'Log a new PO and get a link to share for QA/QC Approval')}</div>
      </div>
    </div>

    <div class="home-nav-card" onclick="location.href='reporting.html'">
      <div class="home-nav-icon">📋</div>
      <div class="home-nav-text">
        <div class="home-nav-title">${biBlockHtml('homeReportingTitle', 'QA/QC Reporting')}</div>
        <div class="home-nav-desc">${biBlockHtml('homeReportingDesc', 'Create purchase orders and file inspection reports')}</div>
      </div>
    </div>

    <div class="home-nav-card" onclick="location.href='approval.html'">
      <div class="home-nav-icon">✅</div>
      <div class="home-nav-text">
        <div class="home-nav-title">${biBlockHtml('homeApprovalTitle', 'Product Development Approval')}</div>
        <div class="home-nav-desc">${biBlockHtml('homeApprovalDesc', 'Share reference photos with Product Development for sign-off')}</div>
      </div>
    </div>

    <div class="home-nav-card" onclick="location.href='reports.html'">
      <div class="home-nav-icon">📁</div>
      <div class="home-nav-text">
        <div class="home-nav-title">${biBlockHtml('homeReportsTitle', 'Reports')}</div>
        <div class="home-nav-desc">${biBlockHtml('homeReportsDesc', 'Look up and download full reports by SKU')}</div>
      </div>
    </div>

    <div class="home-nav-card" onclick="location.href='order-management.html'">
      <div class="home-nav-icon">📦</div>
      <div class="home-nav-text">
        <div class="home-nav-title">Order Management Hub</div>
        <div class="home-nav-desc">Track active POs, costs, suppliers, and settlement across Toys and Clothing</div>
      </div>
    </div>
  `;
}

(async function init() {
  await loadConfig();
  render();
})();
