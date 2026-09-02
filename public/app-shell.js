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
      { label: 'Suppliers', href: 'order-management.html?view=suppliers', omView: 'suppliers' },
      { label: 'Finances', href: 'order-management.html?view=settlement', omView: 'settlement' },
      { label: 'QA/QC Reporting', href: 'reporting.html' }
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
  const targetPath = item.href.split('?')[0];
  if (path !== targetPath) return false;
  if (targetPath !== 'order-management.html') return true;
  // On order-management.html, disambiguate Order Management / Suppliers /
  // Finances by the ?view= param (defaulting to the home dashboard).
  const params = new URLSearchParams(location.search);
  const view = params.get('view') || 'home';
  return view === item.omView;
}

function buildSidebar() {
  const nav = document.createElement('nav');
  nav.className = 'app-sidebar';
  nav.innerHTML = APP_NAV.map((section) => `
    <div class="app-sidebar-group">${section.group.toUpperCase()}</div>
    ${section.items.map((item) => `
      <a class="app-sidebar-link ${isActiveNavItem(item) ? 'active' : ''}" href="${item.href}">${item.label}</a>
    `).join('')}
  `).join('');
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
