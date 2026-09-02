/* Shared app shell: persistent left sidebar, injected into any page that
 * includes this script. Desktop-first per instruction ("build for web now,
 * optimize for mobile later"). Works by finding the existing <header
 * class="app-header"> and <main> that every page already has, and wrapping
 * them into a flex row with a new sidebar - so no page's existing HTML
 * needs restructuring, just two <link>/<script> includes.
 */

const APP_NAV = [
  {
    group: 'Order Management',
    items: [
      { label: 'New Purchase Order', href: 'reporting.html?mode=newPO' },
      { label: 'Order Management', href: 'order-management.html', omView: 'home' },
      { label: 'QA/QC Reporting', href: 'reporting.html' },
      { label: 'Finances', href: 'order-management.html?view=settlement', omView: 'settlement' }
    ]
  },
  {
    group: 'Product Information',
    items: [
      { label: 'Products', href: 'order-management.html?view=products', omView: 'products' },
      { label: 'Components', href: 'order-management.html?view=components', omView: 'components' },
      { label: 'Suppliers', href: 'order-management.html?view=suppliers', omView: 'suppliers' },
      { label: 'Clients', href: 'clients.html' },
      { label: 'Sizing Charts', href: 'sizing-charts.html' }
    ]
  },
  {
    group: 'QA/QC',
    items: [
      { label: 'Product Development Approval', href: 'approval.html' },
      { label: 'Reports', href: 'reports.html' }
    ]
  },
  {
    group: 'Other',
    items: [
      { label: 'Analytics', href: 'analytics.html' },
      { label: 'Settings', href: 'settings.html' }
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
  nav.innerHTML = `<div class="app-sidebar-inner">${APP_NAV.map((section, idx) => `
    <div class="app-sidebar-section ${idx > 0 ? 'app-sidebar-section-divided' : ''}">
      <div class="app-sidebar-group">${section.group.toUpperCase()}</div>
      ${section.items.map((item) => `
        <a class="app-sidebar-link ${isActiveNavItem(item) ? 'active' : ''}" href="${item.href}">${item.label}</a>
      `).join('')}
    </div>
  `).join('')}</div>`;
  return nav;
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
  flexWrap.appendChild(buildSidebar());
  flexWrap.appendChild(main);
})();
