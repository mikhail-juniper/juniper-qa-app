/* Shared app shell: persistent left sidebar, injected into any page that
 * includes this script. Desktop-first per instruction ("build for web now,
 * optimize for mobile later"). Works by finding the existing <header
 * class="app-header"> and <main> that every page already has, and wrapping
 * them into a flex row with a new sidebar - so no page's existing HTML
 * needs restructuring, just two <link>/<script> includes.
 */

const APP_NAV = [
  {
    group: 'Order Management', groupKey: 'navOrderManagementGroup',
    items: [
      { label: 'New Purchase Order', key: 'navNewPurchaseOrder', href: 'reporting.html?mode=newPO' },
      { label: 'Order Management', key: 'navOrderManagement', href: 'order-management.html', omView: 'home' },
      { label: 'QA/QC Reporting', key: 'navQaQcReporting', href: 'reporting.html' },
      { label: 'Finances', key: 'navFinances', href: 'order-management.html?view=settlement', omView: 'settlement' }
    ]
  },
  {
    group: 'Product Information', groupKey: 'navProductInformation',
    items: [
      { label: 'Products', key: 'navProducts', href: 'order-management.html?view=products', omView: 'products' },
      { label: 'Components', key: 'navComponents', href: 'order-management.html?view=components', omView: 'components' },
      { label: 'Fabric Library', key: 'navFabricLibrary', href: 'order-management.html?view=fabric-library', omView: 'fabric-library' },
      { label: 'Suppliers', key: 'navSuppliers', href: 'order-management.html?view=suppliers', omView: 'suppliers' },
      { label: 'Clients', key: 'navClients', href: 'clients.html' },
      { label: 'Sizing Charts', key: 'navSizingCharts', href: 'sizing-charts.html' }
    ]
  },
  {
    group: 'QA/QC', groupKey: 'navQaQc',
    items: [
      { label: 'Product Development Approval', key: 'navPdApproval', href: 'approval.html' },
      { label: 'Reports', key: 'navReports', href: 'reports.html' }
    ]
  },
  {
    group: 'Other', groupKey: 'navOther',
    items: [
      { label: 'Analytics', key: 'navAnalytics', href: 'analytics.html' },
      { label: 'Settings', key: 'navSettings', href: 'settings.html' }
    ]
  }
];

function isActiveNavItem(item) {
  const path = location.pathname.split('/').pop() || 'index.html';
  const [targetPath, targetQuery] = item.href.split('?');
  if (path !== targetPath) return false;

  if (targetPath === 'order-management.html') {
    // Disambiguate Order Management / Suppliers / Finances / Products /
    // Components by the ?view= param (defaulting to the home dashboard).
    const view = new URLSearchParams(location.search).get('view') || 'home';
    return view === item.omView;
  }

  if (targetPath === 'reporting.html') {
    // reporting.html serves both "New Purchase Order" (?mode=newPO) and
    // plain "QA/QC Reporting" from the same URL - without checking the
    // query string both links would show active at once.
    const hasNewPoMode = new URLSearchParams(location.search).get('mode') === 'newPO';
    const itemWantsNewPoMode = (targetQuery || '').includes('mode=newPO');
    return hasNewPoMode === itemWantsNewPoMode;
  }

  return true;
}

function buildSidebar() {
  const nav = document.createElement('nav');
  nav.className = 'app-sidebar';
  nav.innerHTML = sidebarInnerHtml();
  return nav;
}

/** Nav labels render Chinese-first with English underneath, matching the
 *  QA/QC reporting screens. The i18n table loads asynchronously, so this is
 *  called once immediately (English-only fallback, so the nav is never
 *  blank) and again once translations arrive. */
function sidebarInnerHtml() {
  const i18n = window.JuniperI18n;
  const label = (key, fallback) => (i18n ? i18n.t(key, fallback) : fallback);
  return `<div class="app-sidebar-inner">${APP_NAV.map((section, idx) => `
    <div class="app-sidebar-section ${idx > 0 ? 'app-sidebar-section-divided' : ''}">
      <div class="app-sidebar-group">${label(section.groupKey, section.group)}</div>
      ${section.items.map((item) => `
        <a class="app-sidebar-link ${isActiveNavItem(item) ? 'active' : ''}" href="${item.href}">${label(item.key, item.label)}</a>
      `).join('')}
    </div>
  `).join('')}</div>`;
}

(function initShell() {
  const appRoot = document.getElementById('app');
  if (!appRoot) return;
  const header = appRoot.querySelector('.app-header');
  const main = appRoot.querySelector('main');
  if (!header || !main) return;

  const flexWrap = document.createElement('div');
  flexWrap.className = 'app-body-flex';
  appRoot.insertBefore(flexWrap, main);
  const sidebar = buildSidebar();
  flexWrap.appendChild(sidebar);
  if (window.JuniperI18n) {
    window.JuniperI18n.loadI18n().then(() => { sidebar.innerHTML = sidebarInnerHtml(); });
  }
  flexWrap.appendChild(main);

  // Sticky table headers (order-management.css) and the sidebar itself
  // need to know exactly how tall the sticky app header actually is, not
  // an assumed constant - it varies by content/viewport (safe-area insets,
  // text wrapping, etc.), and being wrong by even a few pixels makes a
  // sticky table header overlap the app header instead of sitting cleanly
  // below it. Re-measured on resize since it can change (e.g. rotation).
  function syncHeaderHeightVar() {
    document.documentElement.style.setProperty('--app-header-height', `${header.offsetHeight}px`);
  }
  syncHeaderHeightVar();
  window.addEventListener('resize', syncHeaderHeightVar);
  if (window.ResizeObserver) new ResizeObserver(syncHeaderHeightVar).observe(header);
})();
