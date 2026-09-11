require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');

const { buildPdf } = require('./lib/pdfBuilder');
const { computeOverallResult, collectAllDefects } = require('./lib/passFail');

/** True for an uploaded file that's a video rather than a still photo -
 *  checked by mimetype first, with an extension fallback for browsers that
 *  send a generic octet-stream. */
function isVideoUpload(file) {
  if (!file) return false;
  if (file.mimetype && file.mimetype.startsWith('video/')) return true;
  return /\.(mp4|mov|m4v|webm|avi|mkv|3gp|hevc)$/i.test(file.originalname || '');
}
const { getRecommendation } = require('./lib/aqlRecommendation');
const submissionLog = require('./lib/submissionLog');
// poStore.js is retired - orderManagementStore is now the single source of
// truth for PO data; QA/QC reporting reads/writes through the toQaShape()
// translation instead. Left in place on disk (unused) rather than deleted,
// in case any historical purchaseOrders.json data needs a one-time import.
const orderManagementStore = require('./lib/orderManagementStore');
// lib/sizingChartStore.js is retired - left on disk unused rather than
// deleted, since fits.json (via /api/fits) is now the single source of
// truth for sizing charts.
const supplierStore = require('./lib/supplierStore');
const warehouseStore = require('./lib/warehouseStore');
const catalogStore = require('./lib/catalogStore');
const fabricLibraryStore = require('./lib/fabricLibraryStore');
const approvalStore = require('./lib/approvalStore');
const approvalPhotoSets = require('./config/approvalPhotoSets.json');
const asanaClient = require('./lib/asanaClient');
const asanaPoSync = require('./lib/asanaPoSync');
const poDispatch = require('./lib/poDispatch');
const messageTemplateStore = require('./lib/messageTemplateStore');
const userStore = require('./lib/userStore');
const supplierAccess = require('./lib/supplierAccess');
const googleAuth = require('./lib/googleAuth');
const gmailSend = require('./lib/gmailSend');
const wechatAuth = require('./lib/wechatAuth');
const wecomAuth = require('./lib/wecomAuth');
const wecomCallback = require('./lib/wecomCallback');
const AdmZip = require('adm-zip');
const ASANA_FIELD_MAP_PATH = path.join(__dirname, 'config', 'asanaFieldMap.json');
function loadAsanaFieldMap() { return loadJson(ASANA_FIELD_MAP_PATH); }

/** Picks the right named photo-slot set for a product: apparel and plush by
 *  top-level category, "book" for Notebook/Sketchbook (an accessories
 *  subcategory), everything else falls back to the default set. */
function resolvePhotoSet(category, subcategory) {
  if (category === 'apparel') return approvalPhotoSets.sets.apparel;
  if (category === 'plush') return approvalPhotoSets.sets.plush;
  if (subcategory === 'notebook') return approvalPhotoSets.sets.book;
  return approvalPhotoSets.sets.default;
}
const analytics = require('./lib/analytics');
// Loaded from the live path below once it's resolved; see FITS_PATH.
let fits = require('./config/fits.json');
const i18n = require('./config/i18n.json');
const categories = require('./config/categories.json');
const aqlTable = require('./config/aql.json');

/**
 * Config the team edits in Settings lives on the PERSISTENT DISK, not in the
 * repo.
 *
 * These five files are written at runtime - dropdown lists like Product
 * Development Leads, unit costs, creator tiers, the AQL table and fits. They
 * used to be read and written under ./config, which ships with the code, so
 * every deploy overwrote them and any edits made through the UI were lost.
 *
 * The repo copy is now a SEED: on first run each file is copied to
 * DATA_DIR/config and everything reads and writes there from then on, so a
 * deploy can't touch it.
 */
const USER_CONFIG_DIR = path.join(submissionLog.DATA_DIR, 'config');

function userConfigPath(filename) {
  const live = path.join(USER_CONFIG_DIR, filename);
  if (!fs.existsSync(live)) {
    try {
      fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
      const shipped = path.join(__dirname, 'config', filename);
      if (fs.existsSync(shipped)) {
        fs.copyFileSync(shipped, live);
        console.log(`Seeded editable config ${filename} onto the data disk.`);
      }
    } catch (err) {
      // If the disk isn't writable, fall back to the shipped copy so the
      // app still starts - edits won't persist, but nothing breaks.
      console.error(`Could not seed ${filename} to the data disk:`, err.message || err);
      return path.join(__dirname, 'config', filename);
    }
  }
  return live;
}

const OPTIONS_PATH = userConfigPath('options.json');
const CREATOR_TIERS_PATH = userConfigPath('creatorTiers.json');
const AQL_RECOMMENDATION_PATH = userConfigPath('aqlRecommendation.json');
const UNIT_COSTS_PATH = userConfigPath('unitCosts.json');
const FITS_PATH = userConfigPath('fits.json');
const EDITABLE_OPTION_LISTS = ['creators', 'factoryCodes', 'qaLeads', 'productDevelopmentLeads', 'sourcers'];

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function saveJson(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2)); }
/* fits was require()d from the repo above, which would ignore edits saved
 * to the disk copy. Re-read it from the live path now that it's resolved. */
try {
  fits = loadJson(FITS_PATH);
} catch (err) {
  console.error('Could not read fits.json from the data disk; using the shipped copy:', err.message || err);
}

function loadOptions() { return loadJson(OPTIONS_PATH); }
function saveOptions(newOptions) { saveJson(OPTIONS_PATH, newOptions); }

/** If someone types a value that isn't already in one of the editable
 *  dropdown lists (Factory Code, QA/QC Lead, Product Development Lead),
 *  save it so it shows up as an option for everyone going forward. Case-
 *  insensitive match to avoid near-duplicates like "chloe" vs "Chloe". */
function addNewOptionIfMissing(listKey, value) {
  const trimmed = value && String(value).trim();
  if (!trimmed) return;
  const options = loadOptions();
  if (!Array.isArray(options[listKey])) return;
  const alreadyExists = options[listKey].some((v) => String(v).trim().toLowerCase() === trimmed.toLowerCase());
  if (alreadyExists) return;
  options[listKey].push(trimmed);
  saveOptions(options);
}

/** Puts a PO's selected sizes in Youth XS -> Adult 5XL order (matching
 *  fits.json's universalSizes) instead of whatever order they were clicked
 *  in on the New Purchase Order form. */
function sortSizesCanonically(sizes) {
  const canonical = (fits && fits.universalSizes) || [];
  const keyOf = (item) => (typeof item === 'string' ? item : item.size);
  return [...(sizes || [])].sort((a, b) => {
    const ia = canonical.indexOf(keyOf(a));
    const ib = canonical.indexOf(keyOf(b));
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

const app = express();
// Render (and most hosts) sit behind a proxy that terminates HTTPS and
// forwards requests internally as HTTP - without this, req.protocol would
// incorrectly report "http" even for a real HTTPS visitor, which matters
// for building the correct absolute approval link sent to Asana below.
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

// ---- Storage for uploaded photos (temp, per-submission) ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 60 } // 15MB/photo, 60 photos max per submission
});

// Separate, much larger limit specifically for restoring a downloaded
// backup zip - these accumulate PDFs and photos over time and can be far
// bigger than any single photo upload.
const uploadBackup = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB
});

app.use(express.json({ limit: '5mb' }));

// ---- Authentication & sessions ----
// Two ways in, deliberately:
//
//  1. The original shared site password. Still works, and still grants full
//     access, so deploying this change never locks anybody out. It maps to a
//     synthetic "shared access" admin identity.
//  2. Per-user accounts (lib/userStore) with roles and permissions. These
//     are what Google and WeChat sign-in will attach to later - each of
//     those just resolves to a user record and issues the same session.
//
// The session cookie carries a signed payload rather than a bare token, so
// the server knows *who* is logged in, not merely *that* someone is.
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'JuniperTO';
const AUTH_COOKIE_NAME = 'juniper_auth';
// Supplier access links use their OWN cookie. Sharing one cookie meant an
// internal user who opened a supplier link (to check it, or via the Open
// button) had their admin session silently replaced by a supplier session -
// after which every other link in the app redirected them to the supplier
// page. Separate cookies let both coexist, with the staff session winning.
const SUPPLIER_COOKIE_NAME = 'juniper_supplier_auth';
const SESSION_SECRET = process.env.SESSION_SECRET || `${SITE_PASSWORD}::juniper-site-gate`;

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function readSession(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  // Constant-time compare so the signature can't be brute-forced by timing.
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (err) {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function issueSession(res, session, cookieName) {
  res.cookie(cookieName || AUTH_COOKIE_NAME, signSession(session), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 90 * 24 * 60 * 60 * 1000 // 90 days
  });
}

/** The shared-password identity: full access, but not a real user record. */
const SHARED_SESSION = { kind: 'shared', role: 'admin', name: 'Shared access' };

/**
 * Resolve the current request's user. Returns a user-shaped object for both
 * session kinds so downstream permission checks don't care which was used.
 *
 * Shared sessions carry a chosen "view as" role. That is a PREVIEW
 * MECHANISM, not access control - anyone holding the site password can pick
 * any role, including admin. Its value is that the choice lives in the
 * signed session and is enforced server-side, so supplier scoping and
 * permission checks are genuinely exercised while the role-based views get
 * built. Real per-user accounts (and later Google/WeChat) are what actually
 * restrict anyone.
 */
function currentUser(req) {
  const cookies = parseCookies(req);
  // A staff session always takes precedence, so following a supplier link
  // doesn't downgrade a signed-in employee.
  const session = readSession(cookies[AUTH_COOKIE_NAME])
    || readSession(cookies[SUPPLIER_COOKIE_NAME]);
  if (!session) return null;
  if (session.kind === 'shared') {
    const role = userStore.ROLES.includes(session.viewRole) ? session.viewRole : 'admin';
    return {
      ...SHARED_SESSION,
      id: null,
      active: true,
      role,
      isSharedSession: true,
      supplierName: session.viewSupplierName || '',
      name: role === 'admin' ? 'Shared access' : `Shared access (${role})`
    };
  }
  if (session.kind === 'approvalLink') {
    // Scoped to exactly one order: approval read/write, nothing else.
    const order = orderManagementStore.getOrderById(session.orderId);
    if (!order || !order.approvalAccessToken) return null;
    return {
      id: null,
      name: 'Approval link',
      role: 'qa',
      active: true,
      approvalOrderId: order.id,
      viaAccessLink: true
    };
  }
  if (session.kind === 'supplierLink') {
    // A link-based visitor is a supplier with no account behind them. Read
    // scope only, resolved fresh each request so revoking the token or
    // renaming the supplier takes effect immediately.
    const supplier = supplierStore.getSupplier(session.supplierId);
    if (!supplier || !supplier.accessToken) return null;
    return {
      id: null,
      name: supplier.name,
      role: 'supplier',
      active: true,
      supplierId: supplier.id,
      supplierName: supplier.name,
      viaAccessLink: true
    };
  }
  const user = userStore.getUser(session.userId);
  if (!user || !user.active) return null;
  return user;
}

// Paths that must stay reachable without being logged in yet, so the login
// page itself can load and submit.
/**
 * Domain-ownership verification files. WeCom (WW_verify_*.txt) and WeChat
 * Official Accounts (MP_verify_*.txt) confirm you control a domain by
 * fetching a file from its root - anonymously. Behind the site password
 * they'd 401 and verification would always fail, so they're matched by
 * pattern rather than being listed one by one.
 */
function isDomainVerificationFile(pathname) {
  return /^\/(WW|MP)_verify_[A-Za-z0-9]+\.txt$/.test(pathname);
}

const AUTH_ALLOWLIST = new Set([
  '/login.html', '/api/login', '/api/login-options', '/favicon.ico',
  '/auth/google', '/auth/google/callback',
  '/auth/wechat', '/auth/wechat/callback',
  '/auth/wecom', '/auth/wecom/callback',
  '/wecom/callback'
]);

/**
 * Supplier access link: /s/<token>. Exchanges the token for a read-only,
 * supplier-scoped session and forwards to their order page. Deliberately
 * outside the auth gate - this IS the way in.
 */
// ---- Google sign-in (Juniper staff) ----
// Dormant unless GOOGLE_CLIENT_ID/SECRET are set; the login page hides the
// button in that case.
const GOOGLE_STATE_COOKIE = 'juniper_gstate';
// Marks a callback as coming from the "Connect Gmail" flow rather than a
// plain sign-in, so we know to keep the refresh token and where to return.
const GMAIL_INTENT_COOKIE = 'juniper_gmail_intent';

app.get('/auth/google', (req, res) => {
  if (!googleAuth.isConfigured()) return res.redirect('/login.html?error=google_not_configured');
  const state = googleAuth.makeState();
  // Short-lived cookie ties the callback to this browser (CSRF protection).
  res.cookie(GOOGLE_STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.redirect(googleAuth.authUrl(req, state));
});

// Connect Gmail: same OAuth flow, but additionally asking for send access.
// Kept separate from sign-in so nobody is prompted for send permission just
// to log in.
app.get('/auth/google/gmail', (req, res) => {
  if (!googleAuth.isConfigured()) return res.redirect('/login.html?error=google_not_configured');
  const state = googleAuth.makeState();
  res.cookie(GOOGLE_STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.cookie(GMAIL_INTENT_COOKIE, '1', { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.redirect(googleAuth.authUrl(req, state, [gmailSend.GMAIL_SEND_SCOPE]));
});

app.get('/auth/google/callback', async (req, res) => {
  const fail = (msg) => res.redirect(`/login.html?error=${encodeURIComponent(msg)}`);
  if (!googleAuth.isConfigured()) return fail('Google sign-in is not configured.');
  const expected = parseCookies(req)[GOOGLE_STATE_COOKIE];
  res.clearCookie(GOOGLE_STATE_COOKIE);
  if (!req.query.state || !expected || req.query.state !== expected) {
    return fail('Sign-in expired or was interrupted. Please try again.');
  }
  if (req.query.error) return fail('Google sign-in was cancelled.');
  if (!req.query.code) return fail('Google did not return an authorization code.');

  const gmailIntent = parseCookies(req)[GMAIL_INTENT_COOKIE] === '1';
  res.clearCookie(GMAIL_INTENT_COOKIE);
  try {
    const { profile, tokens } = await googleAuth.completeSignIn(req, req.query.code);

    // Match an existing account by Google id first, then by email so an
    // account created by hand picks up its Google link on first sign-in.
    let user = userStore.findByIdentity('googleSub', profile.sub) || userStore.findByEmail(profile.email);
    if (user) {
      if (!user.googleSub) userStore.updateUser(user.id, { googleSub: profile.sub });
      if (!user.active) return fail('That account has been deactivated.');
      // The owner address is restored to admin if it ever isn't - an account
      // created before this rule existed would otherwise be stuck as team.
      if (googleAuth.shouldForceAdmin(user.email) && user.role !== 'admin') {
        user = userStore.updateUser(user.id, { role: 'admin' }) || user;
        console.log(`Restored admin role for ${user.email}`);
      }
    } else {
      // Auto-provision only when a Workspace domain is enforced - otherwise
      // any Google account in the world could create itself an account.
      if (!googleAuth.allowedDomains().length) {
        return fail('No account exists for that email. Ask an admin to add you.');
      }
      // Anyone on an allowed Juniper domain becomes Juniper Team; emails
      // listed in GOOGLE_ADMIN_EMAILS come in as admin so there's a way to
      // reach admin without the shared password.
      user = userStore.createUser({
        name: profile.name,
        email: profile.email,
        role: googleAuth.defaultRoleFor(profile.email),
        googleSub: profile.sub
      });
      console.log(`Provisioned Google account ${profile.email} as ${user.role}`);
    }
    // Store the refresh token if Google issued one (only happens on the
    // offline/consent flow). Encrypted at rest - see lib/gmailSend.
    if (tokens && tokens.refresh_token) {
      userStore.updateUser(user.id, { gmailRefreshToken: gmailSend.encryptToken(tokens.refresh_token) });
    }
    userStore.recordLogin(user.id);
    issueSession(res, { kind: 'user', userId: user.id });
    if (gmailIntent) {
      const ok = !!(tokens && tokens.refresh_token);
      return res.redirect(`/order-management.html?gmail=${ok ? 'connected' : 'failed'}`);
    }
    return res.redirect(userStore.landingPageFor(user));
  } catch (err) {
    console.error('Google sign-in failed:', err);
    return fail(err.message || 'Google sign-in failed.');
  }
});

/**
 * PD approval link: /a/<token>. Opens the approval page for one PO with no
 * account. Grants approval access to that order only.
 */
app.get('/a/:token', (req, res) => {
  const order = supplierAccess.orderForApprovalToken(orderManagementStore, req.params.token);
  if (!order) {
    return res.status(404).send(
      '<html><body style="font-family:system-ui;padding:40px;text-align:center;">' +
      '<h2>This link is no longer valid</h2>' +
      '<p>Please ask your Juniper contact for an up-to-date link.</p>' +
      '</body></html>'
    );
  }
  // A signed-in Juniper user keeps their own session - checking a link
  // shouldn't downgrade them (same reasoning as /s/:token).
  const existing = currentUser(req);
  if (!existing || existing.role === 'supplier') {
    issueSession(res, { kind: 'approvalLink', orderId: order.id });
  }
  res.redirect(`/approval.html?po=${encodeURIComponent(order.id)}`);
});

// ---- WeChat sign-in ----
// Dormant unless WECHAT_APP_ID/SECRET are set. Official Account mode only
// works inside WeChat's browser; the login page hides the button elsewhere.
const WECHAT_STATE_COOKIE = 'juniper_wxstate';

app.get('/auth/wechat', (req, res) => {
  if (!wechatAuth.isConfigured()) return res.redirect('/login.html?error=wechat_not_configured');
  const state = wechatAuth.makeState();
  res.cookie(WECHAT_STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.redirect(wechatAuth.authUrl(req, state));
});

app.get('/auth/wechat/callback', async (req, res) => {
  const fail = (msg) => res.redirect(`/login.html?error=${encodeURIComponent(msg)}`);
  if (!wechatAuth.isConfigured()) return fail('WeChat sign-in is not configured.');
  const expected = parseCookies(req)[WECHAT_STATE_COOKIE];
  res.clearCookie(WECHAT_STATE_COOKIE);
  if (!req.query.state || !expected || req.query.state !== expected) {
    return fail('Sign-in expired or was interrupted. Please try again.');
  }
  if (!req.query.code) return fail('WeChat did not return an authorization code.');

  try {
    const identity = await wechatAuth.completeSignIn(req.query.code);
    // Match on unionId first (stable across apps), then openId.
    const user = (identity.unionId && userStore.findByIdentity('wechatUnionId', identity.unionId))
      || userStore.findByIdentity('wechatOpenId', identity.openId);
    if (!user) {
      // No auto-provisioning: a WeChat identity carries no verifiable
      // company domain, so an admin has to link it deliberately. The
      // OpenID is shown so they can paste it into the Users page.
      return fail(`No Juniper account is linked to that WeChat yet. Ask an admin to link it (ID: ${identity.openId}).`);
    }
    if (!user.active) return fail('That account has been deactivated.');
    // Backfill whichever identifier we didn't match on.
    const patch = {};
    if (!user.wechatOpenId) patch.wechatOpenId = identity.openId;
    if (identity.unionId && !user.wechatUnionId) patch.wechatUnionId = identity.unionId;
    if (Object.keys(patch).length) userStore.updateUser(user.id, patch);

    userStore.recordLogin(user.id);
    issueSession(res, { kind: 'user', userId: user.id });
    return res.redirect(userStore.landingPageFor(user));
  } catch (err) {
    console.error('WeChat sign-in failed:', err);
    return fail(err.message || 'WeChat sign-in failed.');
  }
});

/**
 * WeCom message-callback URL. Configuring this is what unlocks the Trusted
 * IP setting when the trusted-domain route is unavailable.
 *
 * GET  - WeCom's one-time URL verification. Must reply with the decrypted
 *        echostr as bare text, no JSON, no wrapper.
 * POST - Where WeCom would deliver events. Nothing consumes them yet, so it
 *        acknowledges and discards; replying with an empty 200 is how WeCom
 *        expects "received, no reply needed".
 *
 * Outside the auth gate: WeCom calls it unauthenticated, and the signature
 * check is what actually protects it.
 */
app.get('/wecom/callback', (req, res) => {
  try {
    const echo = wecomCallback.verifyUrl(req.query);
    res.type('text/plain').send(echo);
  } catch (err) {
    console.error('WeCom callback verification failed:', err.message || err);
    res.status(400).type('text/plain').send('verification failed');
  }
});

app.post('/wecom/callback', (req, res) => {
  // Acknowledge immediately. WeCom retries on anything other than a fast
  // 200, and we have no event handling to do yet.
  res.status(200).send('');
});

// ---- WeCom (企业微信) sign-in ----
const WECOM_STATE_COOKIE = 'juniper_wcstate';

app.get('/auth/wecom', (req, res) => {
  if (!wecomAuth.isConfigured()) return res.redirect('/login.html?error=wecom_not_configured');
  const state = wecomAuth.makeState();
  res.cookie(WECOM_STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.redirect(wecomAuth.authUrl(req, state));
});

app.get('/auth/wecom/callback', async (req, res) => {
  const fail = (msg) => res.redirect(`/login.html?error=${encodeURIComponent(msg)}`);
  if (!wecomAuth.isConfigured()) return fail('WeCom sign-in is not configured.');
  const expected = parseCookies(req)[WECOM_STATE_COOKIE];
  res.clearCookie(WECOM_STATE_COOKIE);
  if (!req.query.state || !expected || req.query.state !== expected) {
    return fail('Sign-in expired or was interrupted. Please try again.');
  }
  if (!req.query.code) return fail('WeCom did not return an authorization code.');

  try {
    const identity = await wecomAuth.completeSignIn(req.query.code);

    let user = userStore.findByIdentity('wecomUserId', identity.userId)
      || (identity.email ? userStore.findByEmail(identity.email) : null);

    if (user) {
      if (!user.wecomUserId) userStore.updateUser(user.id, { wecomUserId: identity.userId });
      if (!user.active) return fail('That account has been deactivated.');
    } else {
      // Safe to auto-provision: WeCom only issues a userid to a member of
      // this company's own organisation, so membership is already verified
      // by WeCom itself - the same reasoning as a Workspace domain.
      user = userStore.createUser({
        name: identity.name || identity.userId,
        email: identity.email || `${identity.userId}@wecom.local`,
        role: 'internal',
        wecomUserId: identity.userId
      });
      console.log(`Provisioned WeCom member ${identity.userId} as ${user.role}`);
    }
    userStore.recordLogin(user.id);
    issueSession(res, { kind: 'user', userId: user.id });
    return res.redirect(userStore.landingPageFor(user));
  } catch (err) {
    console.error('WeCom sign-in failed:', err);
    return fail(err.message || 'WeCom sign-in failed.');
  }
});

app.get('/s/:token', (req, res) => {
  const supplier = supplierAccess.supplierForToken(req.params.token);
  if (!supplier) {
    // Same response for an unknown, revoked or malformed token, so a bad
    // link can't be used to probe which tokens are live.
    return res.status(404).send(
      '<html><body style="font-family:system-ui;padding:40px;text-align:center;">' +
      '<h2>This link is no longer valid</h2>' +
      '<p>Please ask your Juniper contact for an up-to-date link.</p>' +
      '</body></html>'
    );
  }
  // If a Juniper user is already signed in, DON'T swap their session for a
  // supplier one - clicking "Open" to check a link would silently demote
  // them to supplier and bounce them out of every internal page. Send them
  // to a preview instead, which uses their own permissions.
  const existing = currentUser(req);
  if (existing && existing.role !== 'supplier') {
    return res.redirect(`/supplier-orders.html?preview=${encodeURIComponent(supplier.name)}`);
  }
  issueSession(res, { kind: 'supplierLink', supplierId: supplier.id }, SUPPLIER_COOKIE_NAME);
  // Serve the page AT this URL rather than redirecting to a generic one, so
  // the address stays unique to the supplier. They can bookmark it, and it
  // keeps working later even after the session cookie expires - revisiting
  // re-establishes the session from the token in the path.
  res.sendFile(path.join(__dirname, 'public', 'supplier-orders.html'));
});

app.post('/api/login', (req, res) => {
  const { password, email } = req.body || {};

  // Per-user login when an email is supplied; shared password otherwise.
  if (email) {
    const user = userStore.authenticate(email, password);
    if (!user) return res.status(401).json({ error: 'Incorrect email or password' });
    issueSession(res, { kind: 'user', userId: user.id });
    return res.json({ ok: true, user: userStore.publicView(user), landing: userStore.landingPageFor(user) });
  }

  if (password !== SITE_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const body = req.body || {};
  const viewRole = userStore.ROLES.includes(body.viewRole) ? body.viewRole : 'admin';
  issueSession(res, {
    ...SHARED_SESSION,
    viewRole,
    viewSupplierName: viewRole === 'supplier' ? (body.viewSupplierName || '') : ''
  });
  res.json({
    ok: true,
    user: { name: SHARED_SESSION.name, role: viewRole },
    landing: userStore.landingPageFor({ role: viewRole })
  });
});

// Switch which account type the shared session is viewing the site as.
// Only meaningful for shared sessions - a real user's role comes from their
// account and can't be self-selected.
app.post('/api/session/view', (req, res) => {
  const session = readSession(parseCookies(req)[AUTH_COOKIE_NAME]);
  if (!session || session.kind !== 'shared') {
    return res.status(400).json({ error: 'View switching is only available on the shared site login' });
  }
  const body = req.body || {};
  if (!userStore.ROLES.includes(body.viewRole)) {
    return res.status(400).json({ error: 'Unknown account type' });
  }
  issueSession(res, {
    ...SHARED_SESSION,
    viewRole: body.viewRole,
    viewSupplierName: body.viewRole === 'supplier' ? (body.viewSupplierName || '') : ''
  });
  res.json({
    ok: true,
    viewRole: body.viewRole,
    viewSupplierName: body.viewSupplierName || '',
    landing: userStore.landingPageFor({ role: body.viewRole })
  });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME);
  res.clearCookie(SUPPLIER_COOKIE_NAME);
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (AUTH_ALLOWLIST.has(req.path)) return next();
  if (isDomainVerificationFile(req.path)) return next();
  const user = currentUser(req);
  if (user) {
    req.user = user; // downstream routes read this for permissions/scoping
    return next();
  }
  // API/asset requests get a plain 401 rather than a redirect, so fetch()
  // calls fail cleanly instead of receiving an HTML login page as "data".
  if (req.path.startsWith('/api/') || req.headers.accept && !req.headers.accept.includes('text/html')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl)}`);
});

/**
 * An approval-link visitor is confined to their one order. Enforced centrally
 * rather than per-route, so a new approval endpoint can't accidentally be
 * left open to every PO.
 */
app.use((req, res, next) => {
  const scopeId = req.user && req.user.approvalOrderId;
  if (!scopeId) return next();

  // Their own order, by id or PO number, is fine; anything else is not.
  // NOTE: req.params is empty in app.use middleware (it's populated by route
  // matching), so the id has to come from the path itself - relying on
  // req.params here silently let other orders through.
  const orderPath = req.path.match(/^\/api\/order-management\/orders\/([^/]+)/);
  const idInPath = orderPath ? decodeURIComponent(orderPath[1]) : null;
  const poInPath = req.path.match(/\/api\/approval\/([^/]+)/);
  const idInQuery = req.query && req.query.po;
  const own = orderManagementStore.getOrderById(scopeId);
  const ownPo = own ? String(own.poNumber || '').toLowerCase() : '';

  if (poInPath) {
    const asked = decodeURIComponent(poInPath[1]).toLowerCase();
    if (asked !== ownPo && asked !== String(scopeId).toLowerCase()) {
      return res.status(404).json({ error: 'Not found' });
    }
  }
  if (idInQuery && String(idInQuery) !== String(scopeId)) {
    return res.status(404).json({ error: 'Not found' });
  }
  // Block the broad list endpoints outright - an approval visitor has no
  // business enumerating orders.
  if (req.path === '/api/order-management/orders' && req.method === 'GET') {
    return res.status(403).json({ error: 'Not permitted on an approval link' });
  }
  if (idInPath) {
    // "by-po-number/<po>" is handled as a PO lookup, everything else as an id.
    if (idInPath === 'by-po-number') {
      const asked = decodeURIComponent(req.path.split('/by-po-number/')[1] || '').toLowerCase();
      if (asked !== ownPo) return res.status(404).json({ error: 'Not found' });
    } else if (idInPath !== String(scopeId)) {
      return res.status(404).json({ error: 'Not found' });
    }
  }
  return next();
});

// Page-level access. A role that can't open a page is redirected to its own
// landing page rather than shown an error - a supplier following an old link
// to the internal order page just ends up on their own order list.
app.use((req, res, next) => {
  if (!req.user) return next();
  const isPage = req.path === '/' || req.path.endsWith('.html');
  if (!isPage) return next();
  const pageName = req.path === '/' ? 'index.html' : req.path.replace(/^\//, '');
  if (userStore.canOpenPage(req.user, pageName)) return next();
  // An approval-link visitor may only open the approval page itself.
  if (req.user.approvalOrderId) {
    return pageName === 'approval.html' ? next() : res.redirect(`/approval.html?po=${encodeURIComponent(req.user.approvalOrderId)}`);
  }
  // Staff previewing a supplier's view are allowed on the supplier page.
  if (pageName === 'supplier-orders.html' && req.query.preview
      && userStore.can(req.user, 'dispatch:send')) return next();
  const landing = userStore.landingPageFor(req.user);
  if (req.path === landing) return next(); // never redirect a page to itself
  return res.redirect(landing);
});

/** Route guard: require a permission, else 403. */
function requirePermission(permission) {
  return (req, res, next) => {
    if (userStore.can(req.user, permission)) return next();
    return res.status(403).json({ error: 'You do not have permission to do that' });
  };
}

// Who am I - drives what the front end shows.
app.get('/api/me', (req, res) => {
  res.json({
    ok: true,
    user: userStore.publicView(req.user),
    permissions: userStore.permissionsFor(req.user && req.user.role),
    roles: userStore.ROLES,
    rolePermissions: userStore.ROLE_PERMISSIONS,
    googleDomains: googleAuth.allowedDomains(),
    pages: userStore.ROLE_PAGES[(req.user && req.user.role) || ''] || [],
    landing: userStore.landingPageFor(req.user),
    canSwitchView: !!(req.user && req.user.isSharedSession)
  });
});

// Roles + supplier names for the login page's account-type picker. Reachable
// before login, since the picker is shown on the login form itself.
app.get('/api/login-options', (req, res) => {
  res.json({
    ok: true,
    roles: userStore.ROLES,
    suppliers: supplierStore.listSuppliers().map((s2) => s2.name).filter(Boolean).sort(),
    wecom: {
      enabled: wecomAuth.isConfigured(),
      // Unlike consumer WeChat, this works everywhere - in the WeCom app
      // it's silent, on desktop it's a QR scan.
      inApp: wecomAuth.isWeComBrowser(req)
    },
    wechat: {
      enabled: wechatAuth.isConfigured(),
      mode: wechatAuth.mode(),
      // Official Account auth only works in WeChat's own browser, so the
      // button is pointless (and confusing) anywhere else.
      usable: wechatAuth.isConfigured()
        && (wechatAuth.mode() === 'qr' || wechatAuth.isWeChatBrowser(req))
    },
    google: {
      enabled: googleAuth.isConfigured(),
      domain: googleAuth.allowedDomain() || null,
      domains: googleAuth.allowedDomains()
    }
  });
});

// Diagnostic: prints the EXACT redirect URI this server will send to Google.
// redirect_uri_mismatch is nearly always a character-level difference (http
// vs https, a trailing slash, www, or a stale host), so guessing is a waste
// of time - copy this value into the Google Cloud console verbatim.
app.get('/api/auth/google/debug', requirePermission('users:manage'), (req, res) => {
  res.json({
    ok: true,
    configured: googleAuth.isConfigured(),
    clientIdSet: !!process.env.GOOGLE_CLIENT_ID,
    clientSecretSet: !!process.env.GOOGLE_CLIENT_SECRET,
    allowedDomains: googleAuth.allowedDomains(),
    adminEmails: googleAuth.adminEmails(),
    // The value that must be registered under "Authorised redirect URIs".
    redirectUriToRegister: googleAuth.callbackUrl(req),
    detected: {
      protocol: req.protocol,
      host: req.get('host'),
      xForwardedProto: req.get('x-forwarded-proto') || null,
      publicBaseUrlEnv: process.env.PUBLIC_BASE_URL || null
    }
  });
});

// ---- PD approval links (per order) ----
app.get('/api/order-management/orders/:id/approval-link', requirePermission('dispatch:send'), (req, res) => {
  const order = orderManagementStore.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    ok: true,
    hasToken: !!order.approvalAccessToken,
    issuedAt: order.approvalAccessTokenIssuedAt || null,
    link: supplierAccess.approvalLinkFor(base, order)
  });
});
app.post('/api/order-management/orders/:id/approval-link', requirePermission('dispatch:send'), (req, res) => {
  const updated = supplierAccess.rotateApprovalToken(orderManagementStore, req.params.id, req.user && req.user.name);
  if (!updated) return res.status(404).json({ error: 'Order not found' });
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ ok: true, link: supplierAccess.approvalLinkFor(base, updated), issuedAt: updated.approvalAccessTokenIssuedAt });
});
app.delete('/api/order-management/orders/:id/approval-link', requirePermission('dispatch:send'), (req, res) => {
  const updated = supplierAccess.revokeApprovalToken(orderManagementStore, req.params.id, req.user && req.user.name);
  if (!updated) return res.status(404).json({ error: 'Order not found' });
  res.json({ ok: true });
});

// Whether the signed-in user can send email from inside the app.
app.get('/api/gmail/status', (req, res) => {
  const user = req.user && req.user.id ? userStore.getUser(req.user.id) : null;
  res.json({
    ok: true,
    available: googleAuth.isConfigured(),
    connected: !!(user && user.gmailRefreshToken),
    // Shared-password sessions have no user record to hang a grant on.
    canConnect: !!(user && googleAuth.isConfigured()),
    email: (user && user.email) || null
  });
});

app.post('/api/gmail/disconnect', (req, res) => {
  if (!req.user || !req.user.id) return res.status(400).json({ error: 'No account to disconnect' });
  userStore.updateUser(req.user.id, { gmailRefreshToken: null });
  res.json({ ok: true });
});

// Why didn't the last email send? Answers the common causes in one place.
app.get('/api/gmail/debug', (req, res) => {
  const user = req.user && req.user.id ? userStore.getUser(req.user.id) : null;
  const token = user && gmailSend.decryptToken(user.gmailRefreshToken);
  const problems = [];
  if (!googleAuth.isConfigured()) problems.push('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set on the server.');
  if (!user) problems.push('You are signed in with the shared site password, which has no user account. Gmail sending needs a personal account - sign in with Google instead.');
  else if (!user.gmailRefreshToken) problems.push('This account has not connected Gmail yet. Use the "Connect Gmail" link in the send dialog.');
  else if (!token) problems.push('A Gmail token is stored but cannot be decrypted (SESSION_SECRET changed). Reconnect Gmail.');
  res.json({
    ok: true,
    sessionKind: req.user ? (req.user.isSharedSession ? 'shared-password' : 'user-account') : 'none',
    signedInAs: (user && user.email) || (req.user && req.user.name) || null,
    googleConfigured: googleAuth.isConfigured(),
    gmailConnected: !!token,
    willSendFromApp: !!token,
    problems
  });
});

// ---- Supplier access links (admin only) ----
app.get('/api/suppliers/:id/access-link', requirePermission('dispatch:send'), (req, res) => {
  const supplier = supplierStore.getSupplier(req.params.id);
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    ok: true,
    hasToken: !!supplier.accessToken,
    issuedAt: supplier.accessTokenIssuedAt || null,
    link: supplierAccess.linkFor(base, supplier)
  });
});
app.post('/api/suppliers/:id/access-link', requirePermission('dispatch:send'), (req, res) => {
  const updated = supplierAccess.rotateToken(req.params.id);
  if (!updated) return res.status(404).json({ error: 'Supplier not found' });
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ ok: true, link: supplierAccess.linkFor(base, updated), issuedAt: updated.accessTokenIssuedAt });
});
app.delete('/api/suppliers/:id/access-link', requirePermission('dispatch:send'), (req, res) => {
  const updated = supplierAccess.revokeToken(req.params.id);
  if (!updated) return res.status(404).json({ error: 'Supplier not found' });
  res.json({ ok: true });
});

// ---- User administration (admin only) ----
app.get('/api/users', requirePermission('users:manage'), (req, res) => {
  res.json({ ok: true, users: userStore.listUsers().map(userStore.publicView), roles: userStore.ROLES });
});
app.post('/api/users', requirePermission('users:manage'), (req, res) => {
  const body = req.body || {};
  if (!body.email) return res.status(400).json({ error: 'email is required' });
  if (userStore.findByEmail(body.email)) return res.status(409).json({ error: 'A user with that email already exists' });
  res.json({ ok: true, user: userStore.publicView(userStore.createUser(body)) });
});
app.patch('/api/users/:id', requirePermission('users:manage'), (req, res) => {
  const updated = userStore.updateUser(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true, user: userStore.publicView(updated) });
});
app.delete('/api/users/:id', requirePermission('users:manage'), (req, res) => {
  if (!userStore.deleteUser(req.params.id)) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));
// Serve generated PDFs so they can be viewed/downloaded - backed by the
// persistent DATA_DIR (see lib/submissionLog.js) so these survive restarts
// once a persistent disk is attached (e.g. on Render's paid tier).
app.use('/submissions', express.static(submissionLog.PDF_ARCHIVE_DIR));
app.use('/issue-photos', express.static(submissionLog.PHOTO_ARCHIVE_DIR));
app.use('/issue-videos', express.static(submissionLog.VIDEO_ARCHIVE_DIR));
app.use('/approval-photos', express.static(approvalStore.APPROVAL_PHOTO_DIR));
app.use('/order-management-files', express.static(orderManagementStore.ORDER_FILES_DIR));
// Fabric Library swatch uploads live here - not tied to any one order, so
// this constant is declared up here (before first use) rather than beside
// uploadFabricFile below, which is defined later in the file.
const FABRIC_LIBRARY_FILES_DIR = path.join(submissionLog.DATA_DIR, 'fabric-library-files');
app.use('/fabric-library-files', express.static(FABRIC_LIBRARY_FILES_DIR));
// Order Management file uploads (style pictures, design docs, packing lists)
// write straight to disk under DATA_DIR/order-management-files/<orderId>/,
// unlike the QA/QC photo uploads above which buffer in memory first - these
// can include larger design files, so streaming to disk avoids holding them
// all in memory at once.
const uploadOrderFile = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(orderManagementStore.ORDER_FILES_DIR, req.params.id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
  }),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB per file
});

// Fabric Library swatch uploads - not tied to any one order, so this gets
// its own small disk-backed folder rather than reusing uploadOrderFile
// (which requires a real order id to write under). FABRIC_LIBRARY_FILES_DIR
// itself is declared earlier, alongside its static-serve route.
const uploadFabricFile = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(FABRIC_LIBRARY_FILES_DIR, { recursive: true });
      cb(null, FABRIC_LIBRARY_FILES_DIR);
    },
    filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB - these are just swatch photos
});

// Serve the fit library + translations + dropdown options + category tree + AQL
// reference table + creator tiers + recommendation table + unit costs to the frontend
// ---- Backup: download everything in DATA_DIR as a zip, and check where
// data is actually being read/written from (helps confirm the persistent
// disk is actually wired up correctly, since a misconfigured DATA_DIR is
// silently invisible otherwise - everything looks fine until a deploy wipes
// it). Do this BEFORE trusting DATA_DIR with real data, and periodically
// as an extra safety net even once it's confirmed working. ----
app.get('/api/backup/status', (req, res) => {
  // Catches both "DATA_DIR isn't set at all" and "DATA_DIR is set but still
  // a relative path" - the second one matters because .env.example ships
  // with DATA_DIR=./data as a documented local-dev default, so someone
  // could have DATA_DIR "set" on Render and still be pointed at a folder
  // that lives inside the app code (wiped on every deploy) rather than an
  // actual persistent disk mount, which is always an absolute path.
  const raw = process.env.DATA_DIR;
  const isUnsetOrRelative = !raw || !path.isAbsolute(raw);
  let diskFree = null;
  try {
    const stat = fs.statfsSync ? fs.statfsSync(submissionLog.DATA_DIR) : null;
    if (stat) diskFree = Math.round((stat.bfree * stat.bsize) / (1024 * 1024));
  } catch (e) { /* statfsSync may not exist on all platforms; not critical */ }
  res.json({
    resolvedDataDir: submissionLog.DATA_DIR,
    usingDefaultLocalFolder: isUnsetOrRelative,
    warning: isUnsetOrRelative
      ? (!raw
          ? 'DATA_DIR is not set - this is using a local folder next to the app code, which Render wipes on every deploy. Set DATA_DIR to your persistent disk\'s mount path (an absolute path, e.g. /var/data) in the Environment tab.'
          : `DATA_DIR is set to "${raw}", which is a relative path - it still resolves to a folder next to the app code, not a persistent disk, so it will be wiped on every deploy. Set it to your disk's absolute mount path instead (e.g. /var/data).`)
      : null,
    freeDiskSpaceMb: diskFree
  });
});

app.get('/api/backup/download', (req, res) => {
  const dir = submissionLog.DATA_DIR;
  const filename = `juniper-qa-backup-${new Date().toISOString().slice(0, 10)}.zip`;
  res.attachment(filename);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('Backup zip failed:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to build backup', detail: String(err.message || err) });
  });
  archive.pipe(res);
  if (fs.existsSync(dir)) archive.directory(dir, false);
  archive.finalize();
});

/** Restores POs (and their approvals, submission history, and referenced
 *  photos/PDFs) from a previously downloaded backup zip - merging into the
 *  current data rather than replacing it wholesale. Any PO in the backup
 *  that isn't already in the live data gets added. For a PO that already
 *  exists, "mode" decides what happens: 'override' replaces the live
 *  record (and its approvals/submissions) with the backup's version;
 *  'ignore' (the default, and the safer choice) leaves the live version
 *  untouched. Photo/PDF files are copied for any added-or-overridden PO;
 *  the shared JSON files are only rewritten once, at the end, so a bad
 *  entry partway through the zip can't leave the data half-updated. */
app.post('/api/backup/upload', uploadBackup.single('backup'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No backup file provided' });
    const mode = req.body.mode === 'override' ? 'override' : 'ignore';

    let zip;
    try {
      zip = new AdmZip(req.file.buffer);
    } catch (err) {
      return res.status(400).json({ error: 'That file does not look like a valid zip archive' });
    }
    const entries = zip.getEntries();

    const readJsonEntry = (name) => {
      const entry = entries.find((e) => e.entryName === name);
      if (!entry) return null;
      try { return JSON.parse(entry.getData().toString('utf8')); } catch { return null; }
    };
    const backupPOs = readJsonEntry('purchaseOrders.json');
    if (!Array.isArray(backupPOs)) {
      return res.status(400).json({ error: "This doesn't look like a Juniper QA backup - purchaseOrders.json is missing or invalid." });
    }
    const backupApprovals = readJsonEntry('approvals.json') || [];
    const backupSubmissions = readJsonEntry('submissions.json') || [];

    const dataDir = submissionLog.DATA_DIR;
    const poPath = path.join(dataDir, 'purchaseOrders.json');
    const approvalsPath = path.join(dataDir, 'approvals.json');
    const submissionsPath = path.join(dataDir, 'submissions.json');
    const livePOs = fs.existsSync(poPath) ? JSON.parse(fs.readFileSync(poPath, 'utf8')) : [];
    const liveApprovals = fs.existsSync(approvalsPath) ? JSON.parse(fs.readFileSync(approvalsPath, 'utf8')) : [];
    const liveSubmissions = fs.existsSync(submissionsPath) ? JSON.parse(fs.readFileSync(submissionsPath, 'utf8')) : [];

    const norm = (s) => String(s || '').trim().toLowerCase();
    const affected = new Set(); // PO numbers being added or overridden - their approvals/submissions/files come along too
    let added = 0, overridden = 0, skipped = 0;

    backupPOs.forEach((po) => {
      const key = norm(po.poNumber);
      const existingIdx = livePOs.findIndex((p) => norm(p.poNumber) === key);
      if (existingIdx === -1) {
        livePOs.push(po);
        added++;
        affected.add(key);
      } else if (mode === 'override') {
        livePOs[existingIdx] = po;
        overridden++;
        affected.add(key);
      } else {
        skipped++;
      }
    });

    backupApprovals.forEach((a) => {
      if (!affected.has(norm(a.poNumber))) return;
      const idx = liveApprovals.findIndex((x) => norm(x.poNumber) === norm(a.poNumber));
      if (idx === -1) liveApprovals.push(a); else liveApprovals[idx] = a;
    });

    backupSubmissions.forEach((s) => {
      if (!affected.has(norm(s.poNumber))) return;
      const idx = liveSubmissions.findIndex((x) => x.submissionId === s.submissionId);
      if (idx === -1) liveSubmissions.push(s); else liveSubmissions[idx] = s;
    });

    // Copy every file from the backup's photo/PDF folders - filenames
    // already carry a random ID (see saveApprovalPhotos, etc.), so
    // collisions with unrelated, already-current files are effectively
    // impossible. Simpler and safer than trying to filter by PO number
    // against a filename convention that could drift over time.
    const extractDir = (zipFolder, diskDir) => {
      const inZip = entries.filter((e) => !e.isDirectory && e.entryName.startsWith(zipFolder + '/'));
      if (!inZip.length) return;
      fs.mkdirSync(diskDir, { recursive: true });
      inZip.forEach((e) => {
        const filename = e.entryName.slice(zipFolder.length + 1);
        if (!filename || filename.includes('/')) return;
        fs.writeFileSync(path.join(diskDir, filename), e.getData());
      });
    };
    extractDir('approval-photos', approvalStore.APPROVAL_PHOTO_DIR);
    extractDir('submissions', submissionLog.PDF_ARCHIVE_DIR);
    extractDir('issue-photos', submissionLog.PHOTO_ARCHIVE_DIR);
    extractDir('issue-videos', submissionLog.VIDEO_ARCHIVE_DIR);

    fs.writeFileSync(poPath, JSON.stringify(livePOs, null, 2));
    fs.writeFileSync(approvalsPath, JSON.stringify(liveApprovals, null, 2));
    fs.writeFileSync(submissionsPath, JSON.stringify(liveSubmissions, null, 2));

    res.json({ ok: true, added, overridden, skipped, mode });
  } catch (err) {
    console.error('Backup upload failed:', err);
    res.status(500).json({ error: 'Failed to process backup upload', detail: String(err.message || err) });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    fits,
    i18n,
    options: loadOptions(),
    categories,
    aql: aqlTable,
    creatorTiers: loadJson(CREATOR_TIERS_PATH),
    aqlRecommendation: loadJson(AQL_RECOMMENDATION_PATH),
    unitCosts: loadJson(UNIT_COSTS_PATH)
  });
});

// ---- Settings: creator tiers (name -> 1/2/3) ----
app.get('/api/creator-tiers', (req, res) => res.json(loadJson(CREATOR_TIERS_PATH)));
app.post('/api/creator-tiers', (req, res) => {
  try {
    const current = loadJson(CREATOR_TIERS_PATH);
    const body = req.body || {};
    if (body.tiers && typeof body.tiers === 'object') {
      const cleaned = {};
      Object.entries(body.tiers).forEach(([name, tier]) => {
        const n = String(name).trim();
        const t = parseInt(tier, 10);
        if (n && [1, 2, 3].includes(t)) cleaned[n] = t;
      });
      current.tiers = cleaned;
    }
    if (body.defaultTier && [1, 2, 3].includes(parseInt(body.defaultTier, 10))) {
      current.defaultTier = parseInt(body.defaultTier, 10);
    }
    saveJson(CREATOR_TIERS_PATH, current);
    res.json({ ok: true, creatorTiers: current });
  } catch (err) {
    console.error('Failed to save creator tiers:', err);
    res.status(500).json({ error: 'Failed to save creator tiers', detail: String(err.message || err) });
  }
});

// ---- Settings: AQL recommendation table (Tier x Risk x PO Size) ----
app.get('/api/aql-recommendation', (req, res) => res.json(loadJson(AQL_RECOMMENDATION_PATH)));
app.post('/api/aql-recommendation', (req, res) => {
  try {
    const current = loadJson(AQL_RECOMMENDATION_PATH);
    const body = req.body || {};
    if (body.table && typeof body.table === 'object') {
      ['1', '2', '3'].forEach((tier) => {
        if (!body.table[tier]) return;
        ['high', 'medium', 'low'].forEach((risk) => {
          if (!body.table[tier][risk]) return;
          ['>20k', '5-20k', '<5k'].forEach((band) => {
            const cell = body.table[tier][risk][band];
            if (cell && cell.pointCheck && [1, 2, 3].includes(parseInt(cell.inspectionLevel, 10))) {
              current.table[tier][risk][band] = {
                pointCheck: String(cell.pointCheck).trim(),
                inspectionLevel: parseInt(cell.inspectionLevel, 10)
              };
            }
          });
        });
      });
    }
    saveJson(AQL_RECOMMENDATION_PATH, current);
    res.json({ ok: true, aqlRecommendation: current });
  } catch (err) {
    console.error('Failed to save AQL recommendation table:', err);
    res.status(500).json({ error: 'Failed to save AQL recommendation table', detail: String(err.message || err) });
  }
});

// ---- Settings: unit costs (category/subcategory -> $) ----
app.get('/api/unit-costs', (req, res) => res.json(loadJson(UNIT_COSTS_PATH)));
app.post('/api/unit-costs', (req, res) => {
  try {
    const current = loadJson(UNIT_COSTS_PATH);
    const body = req.body || {};
    if (body.categories && typeof body.categories === 'object') {
      Object.entries(body.categories).forEach(([cat, subs]) => {
        if (!current.categories[cat] || typeof subs !== 'object') return;
        Object.entries(subs).forEach(([sub, cost]) => {
          const n = parseFloat(cost);
          if (!isNaN(n) && n >= 0) current.categories[cat][sub] = n;
        });
      });
    }
    if (body.otherCategoryFlat !== undefined) {
      const n = parseFloat(body.otherCategoryFlat);
      if (!isNaN(n) && n >= 0) current.otherCategoryFlat = n;
    }
    if (body.rmbToUsdRate !== undefined) {
      const n = parseFloat(body.rmbToUsdRate);
      if (!isNaN(n) && n > 0) current.rmbToUsdRate = n;
    }
    saveJson(UNIT_COSTS_PATH, current);
    res.json({ ok: true, unitCosts: current });
  } catch (err) {
    console.error('Failed to save unit costs:', err);
    res.status(500).json({ error: 'Failed to save unit costs', detail: String(err.message || err) });
  }
});

// ---- Settings: apparel sizing charts (fits.json) ----
app.get('/api/fits', (req, res) => res.json(fits));
app.post('/api/fits', (req, res) => {
  try {
    const body = req.body || {};
    if (!body.fits || typeof body.fits !== 'object') {
      return res.status(400).json({ error: 'fits object is required' });
    }
    const current = loadJson(FITS_PATH);
    const cleanedFits = {};
    Object.entries(body.fits).forEach(([key, fit]) => {
      if (!key || !fit || typeof fit !== 'object') return;
      const points = Array.isArray(fit.points) ? fit.points.filter((p) => typeof p === 'string' && p) : [];
      const pointLabels = {};
      points.forEach((p) => {
        const pl = (fit.pointLabels && fit.pointLabels[p]) || {};
        pointLabels[p] = { en: String(pl.en || p), zh: String(pl.zh || '') };
      });
      const sizes = {};
      if (fit.sizes && typeof fit.sizes === 'object') {
        Object.entries(fit.sizes).forEach(([sizeName, values]) => {
          if (!sizeName || !values || typeof values !== 'object') return;
          const cleanValues = {};
          points.forEach((p) => {
            const v = values[p];
            if (v === undefined || v === null || v === '') return;
            if (typeof v === 'object' && v.min !== undefined && v.max !== undefined) {
              const min = parseFloat(v.min), max = parseFloat(v.max);
              if (!isNaN(min) && !isNaN(max)) cleanValues[p] = { min, max };
            } else {
              const n = parseFloat(v);
              if (!isNaN(n)) cleanValues[p] = n;
            }
          });
          sizes[sizeName] = cleanValues;
        });
      }
      cleanedFits[key] = {
        label_en: String(fit.label_en || key),
        label_zh: String(fit.label_zh || ''),
        group: String(fit.group || 'other'),
        points,
        pointLabels,
        sizes
      };
    });
    current.fits = cleanedFits;
    saveJson(FITS_PATH, current);
    fits = current; // update the in-memory copy so this takes effect without a restart
    res.json({ ok: true, fits: current });
  } catch (err) {
    console.error('Failed to save fits:', err);
    res.status(500).json({ error: 'Failed to save fits', detail: String(err.message || err) });
  }
});

// ---- Settings: read/update the editable dropdown option lists ----
// (creators, factoryCodes, qaLeads - pointCheckRates is a fixed scale, not editable here)
app.get('/api/options', (req, res) => {
  res.json(loadOptions());
});

app.post('/api/options', requirePermission('settings:write'), (req, res) => {
  try {
    const current = loadOptions();
    const body = req.body || {};
    EDITABLE_OPTION_LISTS.forEach((key) => {
      if (Array.isArray(body[key])) {
        const cleaned = body[key]
          .map((v) => String(v).trim())
          .filter((v) => v.length > 0);
        // de-dupe while preserving order
        current[key] = [...new Set(cleaned)];
      }
    });
    saveOptions(current);
    res.json({ ok: true, options: current });
  } catch (err) {
    console.error('Failed to save options:', err);
    res.status(500).json({ error: 'Failed to save options', detail: String(err.message || err) });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ---- Submission endpoint ----
// Accepts multipart form-data:
//   payload: JSON string (see public/app.js buildSubmissionPayload)
//   files: all photos, each with a fieldname that maps back to the payload
app.post('/api/submit', upload.any(), async (req, res) => {
  try {
    if (!req.body.payload) {
      return res.status(400).json({ error: 'Missing payload' });
    }
    const payload = JSON.parse(req.body.payload);
    addNewOptionIfMissing('qaLeads', payload.qaLead);
    const files = req.files || [];

    // Group files by their logical field name (set client-side)
    const filesByField = {};
    for (const f of files) {
      if (!filesByField[f.fieldname]) filesByField[f.fieldname] = [];
      filesByField[f.fieldname].push(f);
    }

    const submissionId = uuidv4();
    // Pull this PO's own established Golden Sample sizing (if any) so the
    // pass/fail tolerance check compares against the actual approved
    // measurements for this product, not just the generic fit template.
    const approvalRecord = approvalStore.getByPoNumber(payload.poNumber);
    const establishedSizing = (approvalRecord && approvalRecord.sampleApproval && approvalRecord.sampleApproval.submitted)
      ? approvalRecord.sampleApproval.data.sizing
      : null;
    const overallResult = computeOverallResult(payload, fits, establishedSizing);
    const recResult = getRecommendation(
      { category: payload.category, subcategory: payload.subcategory, poQuantity: payload.poQuantity, creator: payload.creator, risk: payload.productRisk, sku: payload.sku },
      { unitCosts: loadJson(UNIT_COSTS_PATH), aqlRecConfig: loadJson(AQL_RECOMMENDATION_PATH), creatorTiersConfig: loadJson(CREATOR_TIERS_PATH), findOrdersBySku: orderManagementStore.getOrdersBySku }
    );
    /* getRecommendation now explains why it couldn't recommend instead of
     * returning a bare null. Downstream consumers (the PDF, the stored
     * submission, analytics) expect either a real recommendation or null,
     * so the marker is logged and flattened here rather than leaking. */
    if (recResult && recResult.unavailable) {
      console.log(`Spot check recommendation unavailable for ${payload.poNumber || '(no PO)'}: ${recResult.reason}`);
    }
    const recommendation = (recResult && !recResult.unavailable) ? recResult : null;
    // Videos can't be embedded in a PDF, so each one is archived here and
    // linked from the report. Done before buildPdf so the links can go in.
    fs.mkdirSync(submissionLog.VIDEO_ARCHIVE_DIR, { recursive: true });
    const origin = `${req.protocol}://${req.get('host')}`;
    const videoAttachments = [];
    Object.entries(filesByField).forEach(([field, files]) => {
      (files || []).filter(isVideoUpload).forEach((f, i) => {
        const ext = path.extname(f.originalname || '') || '.mp4';
        const videoFilename = `${submissionId}_${field.replace(/[^A-Za-z0-9_-]/g, '_')}_${i}${ext}`;
        fs.writeFileSync(path.join(submissionLog.VIDEO_ARCHIVE_DIR, videoFilename), f.buffer);
        const url = `/issue-videos/${encodeURIComponent(videoFilename)}`;
        videoAttachments.push({ field, label: f.originalname || videoFilename, url, absoluteUrl: `${origin}${url}` });
      });
    });
    payload._videoAttachments = videoAttachments;

    const pdfBuffer = await buildPdf(payload, filesByField, fits, i18n, overallResult, categories, recommendation, establishedSizing);

    const fileSafePo = (payload.poNumber || 'QA-Report').replace(/[^a-z0-9\-_]+/gi, '_');
    const pdfFilename = `${fileSafePo}_QA_Report_${submissionId.slice(0, 8)}.pdf`;

    // Persist a copy so it can be viewed/downloaded, and referenced later by the
    // report-history and analytics features - now always on, backed by the
    // persistent DATA_DIR rather than the old test-mode-only local folder.
    fs.mkdirSync(submissionLog.PDF_ARCHIVE_DIR, { recursive: true });
    fs.writeFileSync(path.join(submissionLog.PDF_ARCHIVE_DIR, pdfFilename), pdfBuffer);
    const pdfUrl = `/submissions/${encodeURIComponent(pdfFilename)}`;

    // Log this submission for the "reference the previous report" feature and
    // the analytics dashboard. Each defect's first photo is saved separately
    // (in addition to living in the PDF) so the prior-report card can show it
    // inline without needing to open the full PDF.
    fs.mkdirSync(submissionLog.PHOTO_ARCHIVE_DIR, { recursive: true });
    const issuesWithPhotos = collectAllDefects(payload).map((d) => {
      let photoUrl = null;
      const photoFiles = (filesByField[`photo_defect_${d.id}`] || []).filter((f) => !isVideoUpload(f));
      if (photoFiles.length) {
        const photoFilename = `${submissionId}_${d.id}.jpg`;
        fs.writeFileSync(path.join(submissionLog.PHOTO_ARCHIVE_DIR, photoFilename), photoFiles[0].buffer);
        photoUrl = `/issue-photos/${encodeURIComponent(photoFilename)}`;
      }
      return {
        description: d.description || '', severity: d.severity,
        unitsAffected: parseInt(d.unitsAffected, 10) || 1, photoUrl
      };
    });

    // Videos can't be embedded in a PDF, so each one is archived and
    // linked from the report (and from the submission record) instead.
    // Collected earlier, before the PDF is built, so the links can go in it.

    submissionLog.appendSubmission({
      id: submissionId,
      poNumber: payload.poNumber || null,
      sku: payload.sku || (orderManagementStore.getOrderByPoNumber(payload.poNumber) || { mainComponent: {} }).mainComponent.sku || null,
      category: payload.category || null,
      subcategory: payload.subcategory || null,
      creator: payload.creator || null,
      factoryCode: payload.factoryCode || null,
      qaLead: payload.qaLead || null,
      productTitle: payload.productTitle || null,
      productRisk: payload.productRisk || null,
      materials: payload.materials || null,
      printingMethod: payload.printingMethod || null,
      qaType: payload.qaType || null,
      date: payload.date || null,
      submittedAt: new Date().toISOString(),
      poQuantity: payload.poQuantity ? parseInt(payload.poQuantity, 10) : null,
      actualUnitsChecked: payload.actualUnitsChecked ? parseInt(payload.actualUnitsChecked, 10) : null,
      // The app's recommended sampling for this report, kept so Asana's
      // "Proposed Inspection %" can sync from it after the fact.
      recommendation: recommendation || null,
      overallResult: overallResult.overall,
      reasons: overallResult.reasons,
      recap: (overallResult.aql && overallResult.aql.recap) ? overallResult.aql.recap : null,
      criticalCount: overallResult.aql ? overallResult.aql.criticalCount : 0,
      majorCount: overallResult.aql ? overallResult.aql.majorCount : 0,
      minorCount: overallResult.aql ? overallResult.aql.minorCount : 0,
      pdfFilename,
      issues: issuesWithPhotos,
      videoAttachments,
      // Sizing detail carried forward for pre-filling a later report on the same
      // PO - text/numbers only, since photos are physical evidence tied to a
      // specific inspection and shouldn't be silently reused.
      sizingCarryForward: {
        fit: (payload.categoryData && payload.categoryData.fit) || null,
        sizeRows: (payload.categoryData && payload.categoryData.sizeRows) || [],
        customSizeRows: (payload.categoryData && payload.categoryData.customSizeRows) || [],
        simpleSizeValue: (payload.categoryData && payload.categoryData.simpleSizeValue) || null,
        dimensions: (payload.categoryData && payload.categoryData.dimensions) || null
      }
    });

    // File this report against its PO's matching QA/QC stage so the PDF is
    // downloadable from the Order Management panel, and let a passing
    // result advance the order's status automatically.
    try {
      if (payload.poNumber) {
        orderManagementStore.attachSubmittedReport(payload.poNumber, {
          stage: payload.qaType === 'production' ? 'bulk' : 'preProduction',
          submissionId,
          pdfUrl,
          result: overallResult.overall
        }, payload.qaLead || 'QA submission');
      }
    } catch (syncErr) {
      // Never fail the submission itself over this - the report is saved
      // and the PDF exists either way.
      console.error('Failed to attach submitted report to its order:', syncErr);
    }

    res.json({ ok: true, submissionId, filename: pdfFilename, pdfUrl, overallResult });
  } catch (err) {
    console.error('Submission failed:', err);
    res.status(500).json({ error: 'Failed to process submission', detail: String(err.message || err) });
  }
});

// ---- Report history: reference prior reports for the same PO or the same SKU ----
app.get('/api/submission-history/:poNumber', (req, res) => {
  try {
    const prior = submissionLog.findPriorReportsByPoNumber(req.params.poNumber, req.query.excludeId);
    res.json({ reports: prior });
  } catch (err) {
    console.error('Failed to look up submission history:', err);
    res.status(500).json({ error: 'Failed to look up submission history', detail: String(err.message || err) });
  }
});
app.get('/api/submission-history-by-sku/:sku', (req, res) => {
  try {
    const prior = submissionLog.findPriorReportsBySku(req.params.sku, req.query.excludeId);
    res.json({ reports: prior });
  } catch (err) {
    console.error('Failed to look up submission history by SKU:', err);
    res.status(500).json({ error: 'Failed to look up submission history by SKU', detail: String(err.message || err) });
  }
});

// ---- Analytics: vendor dashboard and overall category breakdown ----
function parseDateRange(query) {
  const end = query.end ? new Date(query.end) : new Date();
  const start = query.start ? new Date(query.start) : new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000);
  return { start, end };
}

app.get('/api/analytics/vendor', (req, res) => {
  try {
    if (!req.query.creator) return res.status(400).json({ error: 'creator query param is required' });
    const { start, end } = parseDateRange(req.query);
    const all = submissionLog.getAllSubmissions();
    res.json(analytics.vendorStats(all, req.query.creator, start, end));
  } catch (err) {
    console.error('Failed to compute vendor analytics:', err);
    res.status(500).json({ error: 'Failed to compute vendor analytics', detail: String(err.message || err) });
  }
});

app.get('/api/analytics/factory', (req, res) => {
  try {
    if (!req.query.factoryCode) return res.status(400).json({ error: 'factoryCode query param is required' });
    const { start, end } = parseDateRange(req.query);
    const all = submissionLog.getAllSubmissions();
    res.json(analytics.factoryStats(all, req.query.factoryCode, start, end));
  } catch (err) {
    console.error('Failed to compute factory analytics:', err);
    res.status(500).json({ error: 'Failed to compute factory analytics', detail: String(err.message || err) });
  }
});

app.get('/api/analytics/category', (req, res) => {
  try {
    const { start, end } = parseDateRange(req.query);
    const all = submissionLog.getAllSubmissions();
    res.json({ categories: analytics.categoryStats(all, start, end) });
  } catch (err) {
    console.error('Failed to compute category analytics:', err);
    res.status(500).json({ error: 'Failed to compute category analytics', detail: String(err.message || err) });
  }
});

// ---- Purchase Orders: created via "New Purchase Order", the shared source of
// truth that Pre-Production/Bulk Sampling Reporting and QA/QC Approval both
// pre-fill against. ----
/** Pulls the task GID out of any Asana task URL (the numeric ID after
 *  "/task/"), so the Asana integration can call the API directly with it
 *  regardless of which exact URL format someone pastes in. */
function extractAsanaTaskGid(link) {
  if (!link) return null;
  const str = String(link).trim();
  // Asana task URLs come in several shapes depending on where they were
  // copied from, and only the first was handled before:
  //   .../task/1234                     (task permalink)
  //   .../0/<project>/1234[/f]          (classic project view)
  //   .../0/<project>/task/1234
  //   .../inbox/<gid>/item/1234
  // Fall back to a bare numeric id if someone pastes just the GID.
  const patterns = [
    /\/task\/(\d+)/,
    /\/item\/(\d+)/,
    /\/\d+\/\d+\/(\d+)/,
    /\/(\d{6,})(?:\/f)?\/?(?:\?|#|$)/
  ];
  for (const re of patterns) {
    const m = str.match(re);
    if (m) return m[1];
  }
  return /^\d{6,}$/.test(str) ? str : null;
}

app.post('/api/purchase-orders', requirePermission('orders:write'), (req, res) => {
  try {
    const body = req.body || {};
    if (!body.poNumber || !body.sku) {
      return res.status(400).json({ error: 'poNumber and sku are required' });
    }
    if (orderManagementStore.getOrderByPoNumber(body.poNumber)) {
      return res.status(409).json({ error: 'A PO with this number already exists' });
    }
    addNewOptionIfMissing('productDevelopmentLeads', body.productDevelopmentLead);
    // Sourcer often arrives from the Asana sync rather than being typed.
    addNewOptionIfMissing('sourcers', body.sourcer);
    addNewOptionIfMissing('creators', body.creator);
    const id = uuidv4();

    // If this SKU already has an established apparel fit from a prior PO,
    // carry it forward automatically.
    const established = body.category === 'apparel' ? orderManagementStore.getEstablishedFitForSku(body.sku) : null;

    // category (apparel/plush/bags/accessories/other) is QA/QC's finer
    // classification - map it onto Order Management's coarser productLine
    // (clothing/toys/other) just for tile grouping; category/subcategory
    // themselves are kept as their own fields, not discarded.
    const productLine = body.category === 'apparel' ? 'clothing' : body.category === 'plush' ? 'toys' : 'other';

    const order = orderManagementStore.createOrder({
      id,
      poNumber: body.poNumber,
      productLine,
      status: 'New Request',
      orderPlacementDate: body.orderDate || null,
      fulfillmentRequestDate: body.fulfillmentRequestDate || null,
      // Pulled from Asana by the New PO form's Sync button.
      sourcer: body.sourcer || null,
      fulfillmentChannel: body.fulfillmentChannel || null,
      mainComponent: {
        sku: body.sku,
        name: body.productTitle || '',
        // Fulfillment Channel decides the warehouse (China / US / FBA).
        warehouse: body.warehouse || '',
        purchaseQuantity: body.orderQuantity ? parseInt(body.orderQuantity, 10) : null,
        // Full size/variant distribution from the New PO setup step, if any
        // was entered. Each row can carry its own variant SKU; rows without
        // one fall back to the PO's parent SKU, matching how Order
        // Management already models size variants of one product.
        sizeDistribution: Array.isArray(body.sizeDistribution)
          ? body.sizeDistribution.filter((r) => r && r.size).map((r) => ({ sku: (r.sku && String(r.sku).trim()) || body.sku, size: r.size, quantity: r.quantity != null ? r.quantity : null }))
          : []
      },
      category: body.category || null,
      subcategory: body.subcategory || null,
      creator: body.creator || '',
      productDevelopmentLead: body.productDevelopmentLead || '',
      sizesIncluded: sortSizesCanonically(Array.isArray(body.sizesIncluded) ? body.sizesIncluded : []),
      fitKey: established ? established.fitKey : null,
      fitSizes: established ? established.sizes : [],
      asanaTaskLink: body.asanaTaskLink || null,
      asanaTaskGid: extractAsanaTaskGid(body.asanaTaskLink),
      productRisk: body.productRisk || null
    }, 'Web user');
    const entry = orderManagementStore.toQaShape(order);
    res.json({ ok: true, po: entry, approvalUrl: `/approval.html?po=${encodeURIComponent(id)}` });

    // Best-effort Asana sync: drop this PO's approval page link directly
    // onto the task's QA/QC Drive Link field, so anyone on the task can
    // click straight through without hunting for the right PO in this app.
    if (entry.asanaTaskGid) {
      const fieldMap = loadAsanaFieldMap();
      if (fieldMap.qaqcDriveLinkFieldGid) {
        const approvalLink = `${req.protocol}://${req.get('host')}/approval.html?po=${encodeURIComponent(id)}`;
        asanaClient.setTextCustomField(entry.asanaTaskGid, fieldMap.qaqcDriveLinkFieldGid, approvalLink);
      }
    }
  } catch (err) {
    console.error('Failed to create purchase order:', err);
    res.status(500).json({ error: 'Failed to create purchase order', detail: String(err.message || err) });
  }
});

app.get('/api/purchase-orders/:id', (req, res) => {
  const po = orderManagementStore.toQaShape(orderManagementStore.getOrderById(req.params.id));
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  res.json({ po });
});

app.get('/api/purchase-orders', (req, res) => {
  if (req.query.poNumber) {
    const po = orderManagementStore.toQaShape(orderManagementStore.getOrderByPoNumber(req.query.poNumber));
    return res.json({ pos: po ? [po] : [] });
  }
  if (req.query.sku) {
    return res.json({ pos: orderManagementStore.getOrdersBySku(req.query.sku).map(orderManagementStore.toQaShape) });
  }
  res.status(400).json({ error: 'poNumber or sku query param is required' });
});

app.get('/api/sku-established-fit/:sku', (req, res) => {
  res.json({ fit: orderManagementStore.getEstablishedFitForSku(req.params.sku) });
});

// ---- Order Management Hub ----
// Rebuild of the QingFlow "Order Management" workspace. See
// /docs/order-management-workflow-spec.md for the reverse-engineered
// QingFlow logic this is based on, and the design decisions that diverge
// from it (parent stays in sync, status is manually advanced).

app.get('/api/order-management/statuses', (req, res) => {
  res.json({ statuses: orderManagementStore.STATUSES });
});

app.get('/api/order-management/accessory-statuses', (req, res) => {
  res.json({ statuses: orderManagementStore.ACCESSORY_STATUSES });
});

app.get('/api/order-management/orders', (req, res) => {
  const { productLine, status, search } = req.query;
  const orders = orderManagementStore.listOrders({ productLine, status, search });
  // Staff can preview exactly what one supplier sees, without swapping
  // sessions. Only honoured for people who could send that supplier a PO
  // anyway, so it grants no access they didn't already have.
  const previewAs = req.query.asSupplier;
  const viewer = (previewAs && userStore.can(req.user, 'dispatch:send'))
    ? { role: 'supplier', supplierName: String(previewAs) }
    : req.user;
  const scoped = userStore.scopeOrdersForUser(viewer, orders);
  res.json({ orders: scoped.map((o) => userStore.redactOrderForSupplier(viewer, o)) });
});

// Placed before the generic :id route below, since Express would otherwise
// match "by-po-number" itself as an :id value first.
app.get('/api/order-management/orders/by-po-number/:poNumber', (req, res) => {
  const order = orderManagementStore.getOrderByPoNumber(req.params.poNumber);
  if (!order) return res.status(404).json({ error: 'No PO found with that number' });
  // 404 rather than 403 for out-of-scope orders, so a supplier can't probe
  // which PO numbers exist.
  if (!userStore.canSeeOrder(req.user, order)) return res.status(404).json({ error: 'No PO found with that number' });
  if (req.user && req.user.role === 'supplier') {
    return res.json({ order: userStore.redactOrderForSupplier(req.user, order) });
  }
  res.json({ order });
});

// Also placed before the generic :id route for the same reason.
app.get('/api/order-management/orders/by-sku/:sku', (req, res) => {
  res.json({ orders: orderManagementStore.getOrdersBySku(req.params.sku) });
});

app.get('/api/order-management/orders/:id', (req, res) => {
  const order = orderManagementStore.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!userStore.canSeeOrder(req.user, order)) return res.status(404).json({ error: 'Order not found' });
  const previewAs = req.query.asSupplier;
  const viewer = (previewAs && userStore.can(req.user, 'dispatch:send'))
    ? { role: 'supplier', supplierName: String(previewAs) }
    : req.user;
  res.json({ order: userStore.redactOrderForSupplier(viewer, order) });
});

app.post('/api/order-management/orders', requirePermission('orders:write'), (req, res) => {
  try {
    const body = req.body || {};
    if (!body.poNumber) return res.status(400).json({ error: 'poNumber is required' });
    const existing = orderManagementStore.getOrderByPoNumber(body.poNumber, body.productLine);
    if (existing) {
      return res.status(409).json({
        error: `A ${body.productLine || ''} PO numbered "${body.poNumber}" already exists. Open it from the list to edit instead of creating a duplicate.`,
        existingId: existing.id
      });
    }
    const entry = orderManagementStore.createOrder({ ...body, id: uuidv4() }, body.actor || req.get('X-Actor'));
    res.json({ ok: true, order: entry });
  } catch (err) {
    console.error('Failed to create order:', err);
    res.status(500).json({ error: 'Failed to create order', detail: String(err.message || err) });
  }
});


/**
 * Who a PO dispatch is going out as. Defaults to the signed-in user so
 * Chloe's messages come from Chloe, with an explicit override for the case
 * where someone sends on a colleague's behalf.
 */
function resolveSender(req, body) {
  const user = req.user || {};
  return {
    name: (body && body.fromName) || user.name || '',
    email: (body && body.fromEmail) || user.email || '',
    address: (body && body.fromEmail) || user.email || ''
  };
}

/** Fire-and-forget push of ERP-owned fields to Asana after an order changes.
 *  Deliberately not awaited: Asana latency should never slow down a save,
 *  and a failure there is logged inside the client rather than surfaced. */
function syncOrderToAsana(order, req) {
  if (!order || !order.asanaTaskGid) return;
  Promise.resolve()
    .then(() => asanaPoSync.pushToAsana(order, buildAsanaExtras(order, req)))
    .catch((err) => console.error('Background Asana sync failed:', err.message || err));
}

app.patch('/api/order-management/orders/:id', requirePermission('orders:write'), (req, res) => {
  const body = req.body || {};
  const actor = body.actor || req.get('X-Actor');
  // Order Management Specialist reuses the qaLeads list; a name typed via
  // "+ Add new..." should stick around as a future suggestion, same as
  // Creator/PD Lead already do on the New PO form.
  if (body.patch && body.patch.buyer) addNewOptionIfMissing('qaLeads', body.patch.buyer);
  // A sourcer typed via "+ Add new..." joins the managed list so it's there
  // next time, same as the specialist field above.
  if (body.patch && body.patch.sourcer) addNewOptionIfMissing('sourcers', body.patch.sourcer);
  // Same for a warehouse name typed via "+ Add new..." - it becomes a real
  // Warehouse record (manageable on the Suppliers page's Warehouses
  // section) so it shows up in the dropdown for every future PO.
  if (body.patch && body.patch.mainComponent && body.patch.mainComponent.warehouse) {
    warehouseStore.ensureWarehouseByName(body.patch.mainComponent.warehouse);
  }
  const updated = orderManagementStore.updateOrder(req.params.id, body.patch || {}, actor);
  if (!updated) return res.status(404).json({ error: 'Order not found' });
  syncOrderToAsana(updated, req);
  res.json({ ok: true, order: updated });
});

// Permanently delete a PO. The client requires the user to type the PO
// number before this fires, and it double-checks here so a stray API call
// can't wipe the wrong order.
app.delete('/api/order-management/orders/:id', requirePermission('orders:delete'), (req, res) => {
  const order = orderManagementStore.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const confirmPo = (req.query.confirmPoNumber || (req.body && req.body.confirmPoNumber) || '').trim();
  if (confirmPo.toLowerCase() !== String(order.poNumber || '').trim().toLowerCase()) {
    return res.status(400).json({ error: 'confirmPoNumber must match the order\'s PO number' });
  }
  const removed = orderManagementStore.deleteOrder(req.params.id, req.body && req.body.actor || req.get('X-Actor'));
  if (!removed) return res.status(404).json({ error: 'Order not found' });
  res.json({ ok: true, deleted: { id: removed.id, poNumber: removed.poNumber } });
});

app.post('/api/order-management/orders/:id/status', requirePermission('orders:write'), (req, res) => {
  const body = req.body || {};
  if (!body.status) return res.status(400).json({ error: 'status is required' });
  const updated = orderManagementStore.setStatus(req.params.id, body.status, body.actor || req.get('X-Actor'));
  if (!updated) return res.status(404).json({ error: 'Order not found' });
  syncOrderToAsana(updated, req);
  res.json({ ok: true, order: updated });
});

// Set one QA/QC stage's report status (Pending / In Progress / Completed).
// This also advances the main order status per the workflow mapping, so the
// two never drift apart - see setQaReportStatus.

/**
 * Gathers the ERP -> Asana values that don't live directly on the order
 * record: the PD approval doc link, and the bulk report's inspection
 * numbers/result. Reads the most recent bulk submission for this PO.
 */
function buildAsanaExtras(order, req) {
  const extras = {};
  if (!order) return extras;
  try {
    const base = req ? `${req.protocol}://${req.get('host')}` : (process.env.PUBLIC_BASE_URL || '');
    if (base) extras.approvalLink = `${base}/approval.html?po=${encodeURIComponent(order.id)}`;

    // Deep link to this PO in the ERP, for anyone working from Asana.
    if (base) extras.poLink = `${base}/order-management.html?po=${encodeURIComponent(order.id)}`;

    /* Most recent bulk ("production") report drives Inspection Result.
     *
     * This previously sent the report's PDF URL into that field - but it's a
     * dropdown of Pass / Rework / Exception Approved / Reinspect & Pass, so
     * every write was silently rejected. It now sends the verdict. Proposed
     * Inspection % and QA Check Percentage were removed entirely: those
     * fields are being retired in Asana and their options never matched the
     * numbers we produced. */
    const subs = (submissionLog.findPriorReportsByPoNumber(order.poNumber) || [])
      .filter((sub) => sub.qaType === 'production')
      .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    const bulk = subs[0];
    if (bulk) {
      // Stored as overallResult ('pass' | 'fail') by the report submission.
      const verdict = String(bulk.overallResult || '').trim().toLowerCase();
      if (verdict === 'pass' || verdict === 'passed') extras.inspectionResult = 'Pass';
      else if (verdict === 'fail' || verdict === 'failed') extras.inspectionResult = 'Rework';
      // Anything else (or no verdict) is left alone rather than guessed at.
    }
  } catch (err) {
    // Best-effort: never let this block the caller.
    console.error('buildAsanaExtras failed:', err.message || err);
  }
  return extras;
}

// "Sync from Asana" on the New PO form: given just a PO number, pull the
// Asana-owned fields (Creator, PD, Sourcer, SKU, quantity, fulfil date,
// fulfillment channel -> warehouse) so the requester doesn't retype them.
app.post('/api/asana/pull-po', async (req, res) => {
  const poNumber = (req.body && req.body.poNumber || '').trim();
  if (!poNumber) return res.status(400).json({ error: 'poNumber is required' });
  try {
    const result = await asanaPoSync.pullFromAsana(poNumber);
    if (!result.ok) return res.status(result.notFound ? 404 : 400).json(result);
    // A channel can name a warehouse that doesn't exist in the ERP yet -
    // create it (with the address from config) so the dropdown has it.
    const wh = result.fields.warehouse;
    if (wh && wh.warehouseName) {
      const existing = warehouseStore.listWarehouses().find(
        (w) => (w.name || '').trim().toLowerCase() === wh.warehouseName.trim().toLowerCase());
      if (!existing) {
        warehouseStore.createWarehouse({
          id: uuidv4(), name: wh.warehouseName,
          shippingAddress: wh.address || '', phoneNumber: wh.phone || ''
        });
      }
    }
    res.json(result);
  } catch (err) {
    console.error('Asana pull failed:', err);
    res.status(500).json({ error: 'Asana lookup failed', detail: String(err.message || err) });
  }
});

// Diagnostic: shows what this app is trying to write vs. what the Asana task
// actually offers. Enum fields only accept an exact option-name match, so a
// single renamed/mis-guessed option silently skips that field - this makes
// which ones line up (and which don't) visible without digging in logs.
/**
 * Dump EVERY custom field on a PO's Asana task, not just the ones we write.
 *
 * The existing inspect-po endpoint only reports fields listed in
 * asanaPoSync.json, so a field we don't sync - like "Sample Link" - is
 * invisible there. This shows the raw shape of each field, which is what's
 * needed to work out whether a newer field type (relationship, reference)
 * exposes a usable task GID.
 */
/**
 * Dry run for the PO handoff import.
 *
 * Follows Sample Link -> the handoff task -> its subtasks, and reports what
 * WOULD be imported and where each item would land. Writes nothing: an
 * importer that silently attaches the wrong artwork to a PO is worse than
 * one that does nothing, so the preview comes first.
 *
 * Accepts ?poNumber= (looked up in the ERP) or ?taskGid= (any Asana task,
 * so a PO that isn't in the ERP yet can still be checked).
 */
app.get('/api/asana/handoff-preview', requirePermission('orders:write'), async (req, res) => {
  try {
    let taskGid = String(req.query.taskGid || '').trim();
    // A pasted Asana URL is more convenient than digging out the GID.
    const fromUrl = taskGid.match(/\/task\/(\d+)/);
    if (fromUrl) taskGid = fromUrl[1];

    if (!taskGid) {
      const poNumber = String(req.query.poNumber || '').trim();
      if (!poNumber) return res.status(400).json({ error: 'Pass poNumber or taskGid' });
      const order = orderManagementStore.getOrderByPoNumber(poNumber);
      if (!order) return res.status(404).json({ error: 'PO not found in the ERP' });
      if (!order.asanaTaskGid) return res.status(404).json({ error: 'This PO has no linked Asana task' });
      taskGid = order.asanaTaskGid;
    }

    const task = await asanaClient.getTaskRaw(taskGid, 'name,custom_fields');
    if (!task) return res.status(502).json({ error: 'Asana returned no task' });

    const sampleField = (task.custom_fields || []).find(
      (f) => String(f.name || '').trim().toLowerCase() === 'sample link');
    const sampleValue = sampleField
      ? (sampleField.text_value || sampleField.display_value || '')
      : '';
    if (!sampleValue) {
      return res.json({
        ok: true, taskGid, taskName: task.name,
        sampleLink: null,
        problem: 'Sample Link is empty on this PO - nothing to follow.'
      });
    }

    const handoffMatch = String(sampleValue).match(/\/task\/(\d+)/);
    if (!handoffMatch) {
      return res.json({
        ok: true, taskGid, taskName: task.name, sampleLink: sampleValue,
        problem: 'Sample Link does not contain an Asana task URL.'
      });
    }
    const handoffGid = handoffMatch[1];
    const subtasks = await asanaClient.getSubtasks(handoffGid);

    /* Title decides WHERE it lands, the URL decides HOW it's fetched. Those
     * are independent, which is what lets one list mix Asana comments with
     * Drive folders. */
    const items = subtasks.map((st) => {
      const text = `${st.name || ''}\n${st.notes || ''}`;
      const url = (text.match(/https?:\/\/[^\s)>\]]+/) || [])[0] || null;
      let source = 'none';
      let detail = null;
      if (url) {
        const comment = url.match(/\/task\/(\d+)\/comment\/(\d+)/);
        const drvFolder = url.match(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)/);
        const drvFile = url.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/);
        const asanaTask = url.match(/app\.asana\.com\/.*\/task\/(\d+)/);
        if (comment) { source = 'asanaComment'; detail = { taskGid: comment[1], commentGid: comment[2] }; }
        else if (drvFolder) { source = 'driveFolder'; detail = { folderId: drvFolder[1] }; }
        else if (drvFile) { source = 'driveFile'; detail = { fileId: drvFile[1] }; }
        else if (asanaTask) { source = 'asanaTask'; detail = { taskGid: asanaTask[1] }; }
        else { source = 'unknownUrl'; }
      }
      const label = String(st.name || '').replace(/[:：]\s*$/, '').split(/[:：]/)[0].trim();
      const isSample = /final approved sample|approved sample|golden sample/i.test(label);
      return {
        subtask: st.name,
        label,
        url,
        source,
        detail,
        wouldImportAs: source === 'none' ? 'skipped (no link)'
          : isSample ? 'Golden Sample photos'
          : `PO file - ${label || 'Untitled'}`,
        needsDriveAccess: source === 'driveFolder' || source === 'driveFile'
      };
    });

    res.json({
      ok: true,
      taskGid, taskName: task.name,
      sampleLink: sampleValue,
      handoffTaskGid: handoffGid,
      subtaskCount: subtasks.length,
      items,
      summary: {
        importable: items.filter((i) => i.source === 'asanaComment' || i.source === 'asanaTask').length,
        needsDrive: items.filter((i) => i.needsDriveAccess).length,
        skipped: items.filter((i) => i.source === 'none').length
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get('/api/asana/inspect-task-fields', requirePermission('orders:write'), async (req, res) => {
  try {
    const poNumber = String(req.query.poNumber || '').trim();
    if (!poNumber) return res.status(400).json({ error: 'poNumber is required' });
    const order = orderManagementStore.getOrderByPoNumber(poNumber);
    if (!order) return res.status(404).json({ error: 'PO not found in the ERP' });
    if (!order.asanaTaskGid) return res.status(404).json({ error: 'This PO has no linked Asana task' });

    const task = await asanaClient.getTaskRaw(order.asanaTaskGid, 'name,custom_fields');
    if (!task) return res.status(502).json({ error: 'Asana returned no task - check ASANA_ACCESS_TOKEN' });

    const fields = (task.custom_fields || []).map((f) => ({
      name: f.name,
      type: f.type || f.resource_subtype || null,
      displayValue: f.display_value ?? null,
      // The whole raw object, since the useful identifier on newer field
      // types isn't always in a predictable place.
      raw: f
    }));
    res.json({ ok: true, poNumber, taskGid: order.asanaTaskGid, taskName: task.name, fields });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get('/api/asana/inspect-po', async (req, res) => {
  const poNumber = (req.query.poNumber || '').trim();
  if (!poNumber) return res.status(400).json({ error: 'poNumber query param is required' });
  const order = orderManagementStore.getOrderByPoNumber(poNumber);
  if (!order) return res.status(404).json({ error: `No ERP order found for ${poNumber}` });
  if (!order.asanaTaskGid) return res.status(400).json({ error: 'This order has no linked Asana task.' });
  const task = await asanaClient.getTask(order.asanaTaskGid);
  if (!task) return res.status(502).json({ error: 'Could not fetch the Asana task (token, permissions, or bad task id).' });

  const payload = asanaPoSync.buildPushPayload(order, buildAsanaExtras(order, req));
  const report = Object.entries(payload).map(([fieldName, value]) => {
    const field = (task.custom_fields || []).find(
      (f) => String(f.name || '').trim().toLowerCase() === fieldName.trim().toLowerCase());
    if (!field) return { fieldName, wouldWrite: value, status: 'FIELD NOT FOUND on the Asana task' };
    if (field.type !== 'enum') return { fieldName, wouldWrite: value, type: field.type, status: 'ok' };
    const options = (field.enum_options || []).map((o) => o.name);
    const matched = options.some((o) => String(o).trim().toLowerCase() === String(value).trim().toLowerCase());
    return {
      fieldName, wouldWrite: value, type: 'enum',
      status: matched ? 'ok' : 'NO MATCHING OPTION - fix the name in config/asanaPoSync.json',
      availableOptions: options
    };
  });
  res.json({
    ok: true, poNumber, erpStatus: order.status, asanaTaskGid: order.asanaTaskGid,
    problems: report.filter((r) => r.status !== 'ok'),
    all: report
  });
});

// Push the ERP-owned fields for one order onto its Asana task on demand.
app.post('/api/order-management/orders/:id/asana-push', async (req, res) => {
  const order = orderManagementStore.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const result = await asanaPoSync.pushToAsana(order, buildAsanaExtras(order, req));
  res.json({ ok: true, result });
});

// PD approval statuses for the three stages, shown read-only in the Order
// Management panel's Product Development Approval section.
app.get('/api/order-management/orders/:id/pd-approvals', (req, res) => {
  const order = orderManagementStore.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ ok: true, statuses: approvalStore.pdApprovalStatuses(order.poNumber) });
});

// ---- Message templates (Settings > Message Templates) ----
app.get('/api/message-templates', (req, res) => {
  res.json({ ok: true, templates: messageTemplateStore.listTemplates(), placeholders: messageTemplateStore.PLACEHOLDERS });
});
app.post('/api/message-templates', requirePermission('settings:write'), (req, res) => {
  const body = req.body || {};
  if (!body.name || !String(body.name).trim()) return res.status(400).json({ error: 'name is required' });
  res.json({ ok: true, template: messageTemplateStore.createTemplate(body) });
});
app.patch('/api/message-templates/:id', requirePermission('settings:write'), (req, res) => {
  const updated = messageTemplateStore.updateTemplate(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Template not found' });
  res.json({ ok: true, template: updated });
});
app.delete('/api/message-templates/:id', requirePermission('settings:write'), (req, res) => {
  if (!messageTemplateStore.deleteTemplate(req.params.id)) return res.status(404).json({ error: 'Template not found' });
  res.json({ ok: true });
});

// Everyone who should receive part of this PO, with the contact details on
// file for each - drives the "Send Purchase Order to Supplier" section.
/**
 * Components across all POs that haven't been sent to their supplier yet,
 * grouped by supplier.
 *
 * The natural unit of work is "everything I owe this factory today", which
 * cuts across product lines and PO numbers - five separate plush POs mean
 * five plush-bag orders for the same bag supplier. Sending those one PO at
 * a time is the tedious part, so this groups them instead of making someone
 * filter for them.
 *
 * Only POs that have reached at least Order Placed... actually no: a PO in
 * New Request hasn't been sent to anyone yet, and sending IS what moves it
 * to Order Placed - so those are exactly the ones to include.
 */
/**
 * Assemble the text to paste into WeChat, for one component or many.
 *
 * Both the single-PO row buttons and the batch panel call this, so the two
 * can't drift apart - which is exactly what happened when each built its
 * own string. The per-order wording comes from the editable template; the
 * supplier link is appended ONCE at the end however many orders there are.
 */
app.post('/api/order-management/dispatch-text', requirePermission('dispatch:send'), (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return res.status(400).json({ error: 'No items supplied' });
  const lang = body.lang === 'en' ? 'en' : 'zh';
  const tpl = messageTemplateStore.getDefaultTemplate();
  const base = `${req.protocol}://${req.get('host')}`;

  const blocks = [];
  let portalLink = null;
  for (const it of items) {
    const order = orderManagementStore.getOrderById(it.orderId);
    if (!order) continue;
    const target = poDispatch.buildTargets(order).find((t) => t.key === it.targetKey);
    if (!target) continue;
    // One link for the whole message - the first supplier seen wins, which
    // is correct because a batch is always for a single supplier.
    if (!portalLink && target.supplierId) {
      const sup = supplierAccess.ensureToken(target.supplierId);
      if (sup) portalLink = supplierAccess.linkFor(base, sup);
    }
    const values = poDispatch.templateValues(order, target, portalLink || '', resolveSender(req, body));
    blocks.push(tpl
      ? messageTemplateStore.render(tpl, lang, values).body
      : poDispatch.buildMessage(order, target).body);
  }
  if (!blocks.length) return res.status(404).json({ error: 'Nothing to send' });

  const footer = lang === 'en' ? 'View full order details:' : '查看完整订单详情：';
  const text = blocks.join('\n\n')
    + (portalLink ? `\n\n${footer}\n${portalLink}` : '');
  res.json({ ok: true, text, portalLink });
});

app.get('/api/order-management/dispatch-queue', requirePermission('dispatch:send'), (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const groups = new Map();

  orderManagementStore.listOrders().forEach((order) => {
    poDispatch.buildTargets(order).forEach((t) => {
      if (t.lastSentAt) return;                 // already sent
      if (!t.supplierName) return;              // nowhere to send it
      const key = t.supplierId || `name:${t.supplierName}`;
      if (!groups.has(key)) {
        const sup = t.supplierId ? supplierStore.getSupplier(t.supplierId) : null;
        groups.set(key, {
          supplierId: t.supplierId || null,
          supplierName: t.supplierName,
          wechat: (sup && sup.wechat) || '',
          contactName: (sup && sup.contactName) || '',
          accessLink: (sup && sup.accessToken) ? supplierAccess.linkFor(base, sup) : null,
          items: []
        });
      }
      groups.get(key).items.push({
        orderId: order.id,
        poNumber: order.poNumber,
        targetKey: t.key,
        kind: t.kind,
        componentName: t.componentName,
        productLine: order.productLine,
        // Same row shape the single-PO image uses, so one builder covers both.
        row: {
          ...dispatchImageRow(order, t),
          quantity: t.quantity ?? null,
          deliveryDate: t.deliveryDate || order.manufacturerDeliveryDate || null
        }
      });
    });
  });

  const suppliers = [...groups.values()]
    .sort((a, b) => b.items.length - a.items.length || a.supplierName.localeCompare(b.supplierName));
  res.json({ ok: true, suppliers, totalItems: suppliers.reduce((n, g) => n + g.items.length, 0) });
});

app.get('/api/order-management/orders/:id/dispatch-targets', (req, res) => {
  const order = orderManagementStore.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const base = `${req.protocol}://${req.get('host')}`;
  const me = resolveSender(req, null);
  const targets = poDispatch.buildTargets(order).map((t) => {
    if (!t.supplierId) return t;
    const sup = supplierStore.getSupplier(t.supplierId);
    return { ...t, accessLink: (sup && sup.accessToken) ? supplierAccess.linkFor(base, sup) : null };
  });
  res.json({
    ok: true, poNumber: order.poNumber, targets, sender: me,
    productionNotes: order.productionNotes || ''
  });
});

// The composed message for one component's supplier.
/**
 * The fields the "copy order image" table needs. Kept in one place so the
 * single-component dialog and batch sending draw identical rows.
 */
function dispatchImageRow(order, target) {
  const mc = order.mainComponent || {};
  return {
    productName: mc.name || (target && target.componentName) || '',
    sku: mc.sku || '',
    quantity: mc.purchaseQuantity ?? null,
    photoReference: mc.photoReference || '',
    orderDate: order.orderPlacementDate || null,
    deliveryDate: order.manufacturerDeliveryDate || null,
    productionNotes: order.productionNotes || ''
  };
}

app.get('/api/order-management/orders/:id/dispatch-message/:targetKey', (req, res) => {
  const order = orderManagementStore.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const target = poDispatch.buildTargets(order).find((t) => String(t.key) === String(req.params.targetKey));
  if (!target) return res.status(404).json({ error: 'Component not found on this order' });
  /* The supplier's access link travels with the target so the dialog's
   * "Share Supplier Doc" button has something to copy. ensureToken creates
   * one on demand - the point of the link is that it's always shareable. */
  let accessLink = null;
  if (target.supplierId) {
    const sup = supplierAccess.ensureToken(target.supplierId);
    if (sup) accessLink = supplierAccess.linkFor(`${req.protocol}://${req.get('host')}`, sup);
  }
  res.json({
    ok: true,
    target: { ...target, accessLink },
    /* Rendered from the editable default template so the wording can be
     * changed in Settings. Falls back to the built-in message only if no
     * template exists at all. */
    message: (() => {
      const tpl = messageTemplateStore.getDefaultTemplate();
      if (!tpl) return poDispatch.buildMessage(order, target, accessLink);
      const lang = req.query.lang === 'en' ? 'en' : 'zh';
      return messageTemplateStore.render(
        tpl, lang,
        poDispatch.templateValues(order, target, accessLink, resolveSender(req, req.query)));
    })(),
    // Row data for the "copy PO image" table.
    order: dispatchImageRow(order, target), poNumber: order.poNumber
  });
});

// Render a template against one component's PO details, in the requested
// language. Templates hold separate en/zh versions - never translated.
app.get('/api/order-management/orders/:id/dispatch-message/:targetKey/template/:templateId', (req, res) => {
  const order = orderManagementStore.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const target = poDispatch.buildTargets(order).find((t) => String(t.key) === String(req.params.targetKey));
  if (!target) return res.status(404).json({ error: 'Component not found on this order' });
  const template = messageTemplateStore.getTemplate(req.params.templateId);
  if (!template) return res.status(404).json({ error: 'Template not found' });
  const lang = req.query.lang === 'en' ? 'en' : 'zh';
  // Make sure this supplier has an access link, and include it - the point
  // is that the PO message itself is how they get in.
  let portalLink = '';
  if (target.supplierId) {
    const supplier = supplierAccess.ensureToken(target.supplierId);
    portalLink = supplierAccess.linkFor(`${req.protocol}://${req.get('host')}`, supplier);
  }
  const message = messageTemplateStore.render(
    template, lang, poDispatch.templateValues(order, target, portalLink, resolveSender(req, req.query)));
  res.json({ ok: true, message, target, order: dispatchImageRow(order, target), poNumber: order.poNumber });
});

// Record a dispatch, and optionally save a newly-entered contact back onto
// the supplier record so it's on file for next time.
app.post('/api/order-management/orders/:id/dispatch', requirePermission('dispatch:send'), async (req, res) => {
  const order = orderManagementStore.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const body = req.body || {};
  const { targetKey, channel, recipient, saveToSupplier } = body;
  if (!targetKey || !channel || !recipient) {
    return res.status(400).json({ error: 'targetKey, channel and recipient are required' });
  }
  if (channel !== 'email' && channel !== 'wechat') {
    return res.status(400).json({ error: "channel must be 'email' or 'wechat'" });
  }
  const target = poDispatch.buildTargets(order).find((t) => String(t.key) === String(targetKey));
  if (!target) return res.status(404).json({ error: 'Component not found on this order' });

  // Persist a new contact against the factory so it's reusable.
  if (saveToSupplier && target.supplierId) {
    const patch = channel === 'email' ? { email: recipient } : { wechat: recipient };
    supplierStore.updateSupplier(target.supplierId, patch);
  }

  // Actually send, when the sender has connected Gmail and this is email.
  // Anything else falls back to "composed locally" and the client hands off
  // to the user's mail client or clipboard, exactly as before.
  let delivery = { delivered: false, reason: 'not-email-channel' };
  if (channel === 'email') {
    const senderUser = req.user && req.user.id ? userStore.getUser(req.user.id) : null;
    const refresh = senderUser && gmailSend.decryptToken(senderUser.gmailRefreshToken);
    // Be specific about why a send fell back, so "it didn't send" is
    // diagnosable instead of silent.
    if (!googleAuth.isConfigured()) delivery = { delivered: false, reason: 'google-not-configured' };
    else if (!senderUser) delivery = { delivered: false, reason: 'shared-session-no-user-account' };
    else if (!senderUser.gmailRefreshToken) delivery = { delivered: false, reason: 'gmail-not-connected' };
    else if (!refresh) delivery = { delivered: false, reason: 'stored-token-unreadable' };
    else if (!body.subject || !body.body) delivery = { delivered: false, reason: 'missing-subject-or-body' };
    if (delivery.reason && delivery.reason !== 'not-email-channel') {
      console.log(`PO dispatch not sent server-side: ${delivery.reason}`);
    }
    if (refresh && body.subject && body.body) {
      try {
        const messageId = await gmailSend.sendAs(refresh, {
          to: recipient,
          from: senderUser.email,
          fromName: senderUser.name,
          replyTo: senderUser.email,
          subject: body.subject,
          body: body.body
        });
        delivery = { delivered: true, via: 'gmail', messageId };
      } catch (err) {
        console.error('Gmail send failed:', err.message || err);
        // Report rather than silently logging a dispatch that never went.
        return res.status(502).json({
          error: err.message || 'Could not send the email.',
          needsReconnect: !!err.needsReconnect
        });
      }
    }
  }
  const sender = resolveSender(req, body);
  const entry = poDispatch.buildLogEntry(target, channel, recipient, body.actor || sender.name || req.get('X-Actor'), sender);
  let updated = orderManagementStore.updateOrder(
    order.id,
    {
      dispatchLog: [...(order.dispatchLog || []), entry],
      // Notes written in the send dialog become the factory's production
      // notes. Only overwrite when something was actually typed.
      ...(typeof body.productionNotes === 'string' ? { productionNotes: body.productionNotes } : {})
    },
    body.actor || 'Web user',
    `PO sent to ${target.supplierName || 'supplier'} (${target.componentName}) via ${channel}`
  );

  // Sending a PO places that component's order. The main component's send
  // moves the parent PO to Order Placed; a sub-component's send moves only
  // that component's own status.
  if (target.kind === 'main') {
    const advanced = orderManagementStore.advanceOnMainPoDispatch(order.id, body.actor || 'Web user');
    if (advanced) updated = advanced;
  } else {
    const advanced = orderManagementStore.advanceAccessoryOnDispatch(order.id, target.key, body.actor || 'Web user');
    if (advanced) updated = advanced;
  }
  syncOrderToAsana(updated, req);
  res.json({ ok: true, entry, delivery, order: updated });
});

// Append a bulk shipment progress note. Internal only - the supplier page
// shows these read-only.
app.post('/api/order-management/orders/:id/progress-note', requirePermission('orders:write'), (req, res) => {
  const body = req.body || {};
  if (!body.text || !String(body.text).trim()) {
    return res.status(400).json({ error: 'A note is required' });
  }
  const updated = orderManagementStore.addProgressNote(
    req.params.id,
    body.text,
    body.actor || req.get('X-Actor') || (req.user && req.user.name) || 'Web user'
  );
  if (!updated) return res.status(404).json({ error: 'Order not found' });
  res.json({ ok: true, order: updated });
});

app.post('/api/order-management/orders/:id/qa-report-status', (req, res) => {
  const body = req.body || {};
  if (!body.stage || !body.status) return res.status(400).json({ error: 'stage and status are required' });
  const updated = orderManagementStore.setQaReportStatus(req.params.id, body.stage, body.status, body.actor || req.get('X-Actor'));
  if (!updated) return res.status(400).json({ error: 'Order not found, or invalid stage/status' });
  syncOrderToAsana(updated, req);
  res.json({ ok: true, order: updated });
});

app.post('/api/order-management/orders/:id/settlement', (req, res) => {
  const body = req.body || {};
  if (!body.status) return res.status(400).json({ error: 'status is required' });
  const updated = orderManagementStore.setSettlement(req.params.id, body.status, body.actor || req.get('X-Actor'));
  if (!updated) return res.status(404).json({ error: 'Order not found' });
  res.json({ ok: true, order: updated });
});

app.get('/api/order-management/suppliers', (req, res) => {
  res.json({ suppliers: orderManagementStore.listSuppliers(req.query.productLine) });
});

app.get('/api/order-management/products', (req, res) => {
  res.json({ products: orderManagementStore.listProducts(req.query.productLine) });
});

app.get('/api/order-management/components', (req, res) => {
  res.json({ components: orderManagementStore.listComponents(req.query.productLine) });
});

app.get('/api/order-management/field-history', (req, res) => {
  res.json(orderManagementStore.getFieldHistory());
});

// (The simple sizingChartStore-based /api/sizing-charts routes that used to
// live here are retired - the real fits.json-backed system, exposed via
// /api/fits below, is now the single source of truth for sizing charts,
// shared between QA/QC reporting and Order Management.)

// ---- Suppliers (real master data, per Product Information) ----
app.get('/api/suppliers', (req, res) => {
  // The raw access token is a credential, so it never goes out in the
  // general list. Anyone allowed to send a PO gets the usable link instead;
  // everyone else just learns whether one exists.
  const mayShare = userStore.can(req.user, 'dispatch:send');
  const base = `${req.protocol}://${req.get('host')}`;
  const suppliers = supplierStore.listSuppliers().map((sup) => {
    const { accessToken, ...rest } = sup;
    return {
      ...rest,
      hasAccessLink: !!accessToken,
      accessLink: mayShare && accessToken ? supplierAccess.linkFor(base, sup) : null
    };
  });
  res.json({ suppliers });
});
app.get('/api/suppliers/:id', (req, res) => {
  const supplier = supplierStore.getSupplier(req.params.id);
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
  res.json({ supplier });
});
app.post('/api/suppliers', (req, res) => {
  const body = req.body || {};
  if (!body.name) return res.status(400).json({ error: 'name is required' });
  const supplier = supplierStore.createSupplier({ ...body, id: uuidv4() });
  res.json({ ok: true, supplier });
});
app.patch('/api/suppliers/:id', (req, res) => {
  const updated = supplierStore.updateSupplier(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Supplier not found' });
  res.json({ ok: true, supplier: updated });
});
app.delete('/api/suppliers/:id', (req, res) => {
  const ok = supplierStore.deleteSupplier(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Supplier not found' });
  res.json({ ok: true });
});

// ---- Warehouses (split out from Suppliers) ----
app.get('/api/warehouses', (req, res) => {
  res.json({ warehouses: warehouseStore.listWarehouses() });
});
app.get('/api/warehouses/:id', (req, res) => {
  const warehouse = warehouseStore.getWarehouse(req.params.id);
  if (!warehouse) return res.status(404).json({ error: 'Warehouse not found' });
  res.json({ warehouse });
});
app.post('/api/warehouses', (req, res) => {
  const body = req.body || {};
  if (!body.name) return res.status(400).json({ error: 'name is required' });
  const warehouse = warehouseStore.createWarehouse({ ...body, id: uuidv4() });
  res.json({ ok: true, warehouse });
});
app.patch('/api/warehouses/:id', (req, res) => {
  const updated = warehouseStore.updateWarehouse(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Warehouse not found' });
  res.json({ ok: true, warehouse: updated });
});
app.delete('/api/warehouses/:id', (req, res) => {
  const ok = warehouseStore.deleteWarehouse(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Warehouse not found' });
  res.json({ ok: true });
});

// ---- Products / Components directory (Product Information) ----
// The catalog is now the single directory - every SKU/part seen on any PO
// gets a record here automatically (see catalogStore.syncFromOrder, wired
// into order create/update), so listing it also runs a cheap, idempotent
// backfill first to pick up anything from before this directory existed.
// Each item comes back with its live "poCount" so the list can show it
// without a separate request per row.
app.get('/api/catalog/products', (req, res) => {
  catalogStore.backfillFromOrders(orderManagementStore.listOrders({}));
  const products = catalogStore.listManualProducts().map((p) => ({
    ...p,
    poCount: orderManagementStore.getOrdersForProduct(p.sku, p.name).length
  }));
  res.json({ products });
});
app.post('/api/catalog/products', (req, res) => {
  const body = req.body || {};
  if (!body.name) return res.status(400).json({ error: 'name is required' });
  const product = catalogStore.createManualProduct({ ...body, id: uuidv4() });
  res.json({ ok: true, product });
});
app.get('/api/catalog/products/:id', (req, res) => {
  const product = catalogStore.getManualProduct(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json({ product });
});
app.patch('/api/catalog/products/:id', (req, res) => {
  const updated = catalogStore.updateManualProduct(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Product not found' });
  res.json({ ok: true, product: updated });
});
app.delete('/api/catalog/products/:id', (req, res) => {
  const ok = catalogStore.deleteManualProduct(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Product not found' });
  res.json({ ok: true });
});
// Historical POs for one product - the list a click on "Historical POs"
// opens back into via Order Management's own full PO view.
app.get('/api/catalog/products/:id/history', (req, res) => {
  const product = catalogStore.getManualProduct(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const orders = orderManagementStore.getOrdersForProduct(product.sku, product.name);
  res.json({ orders: orders.map(orderManagementStore.toQaShape) });
});

app.get('/api/catalog/components', (req, res) => {
  catalogStore.backfillFromOrders(orderManagementStore.listOrders({}));
  const components = catalogStore.listManualComponents().map((c) => ({
    ...c,
    useCount: orderManagementStore.getOrdersForComponent(c.partName, c.supplierName).length
  }));
  res.json({ components });
});
app.post('/api/catalog/components', (req, res) => {
  const body = req.body || {};
  if (!body.partName) return res.status(400).json({ error: 'partName is required' });
  const component = catalogStore.createManualComponent({ ...body, id: uuidv4() });
  res.json({ ok: true, component });
});
app.get('/api/catalog/components/:id', (req, res) => {
  const component = catalogStore.getManualComponent(req.params.id);
  if (!component) return res.status(404).json({ error: 'Component not found' });
  res.json({ component });
});
app.patch('/api/catalog/components/:id', (req, res) => {
  const updated = catalogStore.updateManualComponent(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Component not found' });
  res.json({ ok: true, component: updated });
});
app.delete('/api/catalog/components/:id', (req, res) => {
  const ok = catalogStore.deleteManualComponent(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Component not found' });
  res.json({ ok: true });
});
// Historical POs for one component.
app.get('/api/catalog/components/:id/history', (req, res) => {
  const component = catalogStore.getManualComponent(req.params.id);
  if (!component) return res.status(404).json({ error: 'Component not found' });
  const orders = orderManagementStore.getOrdersForComponent(component.partName, component.supplierName);
  res.json({ orders: orders.map(orderManagementStore.toQaShape) });
});

// ---- Fabric Library (Fabric Codes / Fabric Types) ----
// Same auto-sync directory pattern as Products/Components: any fabric
// code/type entered on a PO's Main Component Specifications, or on a
// catalog Product, gets a record here automatically the first time it's
// seen. Backfill runs on every list request, same reasoning as catalog.
app.get('/api/fabric-library/codes', (req, res) => {
  fabricLibraryStore.backfillFromOrders(orderManagementStore.listOrders({}));
  fabricLibraryStore.backfillFromProducts(catalogStore.listManualProducts());
  res.json({ codes: fabricLibraryStore.listFabricCodes() });
});
app.post('/api/fabric-library/codes', (req, res) => {
  const body = req.body || {};
  if (!body.value) return res.status(400).json({ error: 'value is required' });
  const code = fabricLibraryStore.createFabricCode({ ...body, id: uuidv4() });
  res.json({ ok: true, code });
});
app.patch('/api/fabric-library/codes/:id', (req, res) => {
  const updated = fabricLibraryStore.updateFabricCode(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Fabric code not found' });
  res.json({ ok: true, code: updated });
});
app.delete('/api/fabric-library/codes/:id', (req, res) => {
  const ok = fabricLibraryStore.deleteFabricCode(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Fabric code not found' });
  res.json({ ok: true });
});

// Historical POs whose main component used this fabric code - matched by
// the entry's value or its pantone (POs may reference either), so both
// naming conventions link up.
app.get('/api/fabric-library/codes/:id/history', (req, res) => {
  const code = fabricLibraryStore.listFabricCodes().find((c) => c.id === req.params.id);
  if (!code) return res.status(404).json({ error: 'Fabric code not found' });
  const orders = orderManagementStore.getOrdersForFabric('fabricInfo', [code.value, code.pantone]);
  res.json({ orders: orders.map(orderManagementStore.toQaShape) });
});

app.get('/api/fabric-library/types/:id/history', (req, res) => {
  const type = fabricLibraryStore.listFabricTypes().find((t) => t.id === req.params.id);
  if (!type) return res.status(404).json({ error: 'Fabric type not found' });
  const orders = orderManagementStore.getOrdersForFabric('component', [type.value]);
  res.json({ orders: orders.map(orderManagementStore.toQaShape) });
});

app.get('/api/fabric-library/types', (req, res) => {  fabricLibraryStore.backfillFromOrders(orderManagementStore.listOrders({}));
  fabricLibraryStore.backfillFromProducts(catalogStore.listManualProducts());
  res.json({ types: fabricLibraryStore.listFabricTypes() });
});
app.post('/api/fabric-library/types', (req, res) => {
  const body = req.body || {};
  if (!body.value) return res.status(400).json({ error: 'value is required' });
  const type = fabricLibraryStore.createFabricType({ ...body, id: uuidv4() });
  res.json({ ok: true, type });
});
app.patch('/api/fabric-library/types/:id', (req, res) => {
  const updated = fabricLibraryStore.updateFabricType(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Fabric type not found' });
  res.json({ ok: true, type: updated });
});
app.delete('/api/fabric-library/types/:id', (req, res) => {
  const ok = fabricLibraryStore.deleteFabricType(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Fabric type not found' });
  res.json({ ok: true });
});

app.get('/api/order-management/counts', (req, res) => {
  res.json(orderManagementStore.getCounts());
});

app.get('/api/order-management/financials/monthly', (req, res) => {
  res.json({ months: orderManagementStore.getMonthlyFinancials() });
});

app.get('/api/order-management/file-categories', (req, res) => {
  res.json({ categories: orderManagementStore.FILE_CATEGORIES });
});

app.post('/api/order-management/orders/:id/files', uploadOrderFile.single('file'), (req, res) => {
  try {
    if (!orderManagementStore.getOrderById(req.params.id)) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const category = orderManagementStore.FILE_CATEGORIES.includes(req.body.category)
      ? req.body.category : 'Other';
    const file = {
      id: uuidv4(),
      category,
      originalName: req.file.originalname,
      storedName: req.file.filename,
      size: req.file.size,
      relatedTo: (req.body.relatedTo || '').trim() || null,
      url: `/order-management-files/${encodeURIComponent(req.params.id)}/${encodeURIComponent(req.file.filename)}`,
      uploadedAt: new Date().toISOString(),
      uploadedBy: req.body.actor || req.get('X-Actor') || 'Unknown'
    };
    const updated = orderManagementStore.addFile(req.params.id, file, file.uploadedBy);
    res.json({ ok: true, order: updated, file });
  } catch (err) {
    console.error('Failed to upload order file:', err);
    res.status(500).json({ error: 'Failed to upload file', detail: String(err.message || err) });
  }
});

// Fabric Library swatch upload - standalone, not attached to an order.
app.post('/api/fabric-library/upload', uploadFabricFile.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ ok: true, file: { url: `/fabric-library-files/${encodeURIComponent(req.file.filename)}` } });
  } catch (err) {
    console.error('Failed to upload fabric swatch:', err);
    res.status(500).json({ error: 'Failed to upload file', detail: String(err.message || err) });
  }
});

app.delete('/api/order-management/orders/:id/files/:fileId', (req, res) => {  const updated = orderManagementStore.removeFile(req.params.id, req.params.fileId, req.get('X-Actor'));
  if (!updated) return res.status(404).json({ error: 'Order not found' });
  res.json({ ok: true, order: updated });
});

// ---- QA/QC Approval workflow ----
const STAGE_KEY_MAP = { sample: 'sampleApproval', preProduction: 'preProductionApproval', bulk: 'bulkApproval' };

function saveApprovalPhotos(files, prefix) {
  fs.mkdirSync(approvalStore.APPROVAL_PHOTO_DIR, { recursive: true });
  const urls = [];
  (files || []).forEach((f, i) => {
    const filename = `${prefix}_${i}_${uuidv4().slice(0, 8)}.jpg`;
    fs.writeFileSync(path.join(approvalStore.APPROVAL_PHOTO_DIR, filename), f.buffer);
    urls.push(`/approval-photos/${encodeURIComponent(filename)}`);
  });
  return urls;
}

app.get('/api/approval/:poNumber', (req, res) => {
  try {
    const po = orderManagementStore.toQaShape(orderManagementStore.getOrderByPoNumber(req.params.poNumber));
    if (!po) return res.status(404).json({ error: 'Purchase order not found - has it been created via New Purchase Order?' });

    const photoSet = resolvePhotoSet(po.category, po.subcategory);
    const approval = approvalStore.getOrCreateByPoNumber(po.poNumber, po.sku);
    const priorSampleApproval = approvalStore.getPriorSampleApprovalForSku(po.sku, po.poNumber);
    const reportingHistory = submissionLog.findPriorReportsBySku(po.sku);

    res.json({ po, photoSet, approval, priorSampleApproval, reportingHistory });
  } catch (err) {
    console.error('Failed to load approval record:', err);
    res.status(500).json({ error: 'Failed to load approval record', detail: String(err.message || err) });
  }
});

app.post('/api/approval/:poNumber/:stage', upload.any(), (req, res) => {
  try {
    const stageKey = STAGE_KEY_MAP[req.params.stage];
    if (!stageKey) return res.status(400).json({ error: 'Unknown approval stage' });
    const po = orderManagementStore.toQaShape(orderManagementStore.getOrderByPoNumber(req.params.poNumber));
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });

    const data = JSON.parse((req.body && req.body.data) || '{}');
    if (req.params.stage === 'sample') {
      addNewOptionIfMissing('factoryCodes', data.factoryCode);
      addNewOptionIfMissing('qaLeads', data.qaLead);
    }
    const filesByField = {};
    (req.files || []).forEach((f) => {
      if (!filesByField[f.fieldname]) filesByField[f.fieldname] = [];
      filesByField[f.fieldname].push(f);
    });

    // Photos come in per named slot (e.g. photo_front, photo_back) or, for
    // per-size apparel Pre-Production/Bulk Approval, per slot+size
    // (photo_front__Adult_M). Save each and build a slot -> URLs map.
    const photos = {};
    Object.keys(filesByField).forEach((field) => {
      if (!field.startsWith('photo_')) return;
      const slotKey = field.slice('photo_'.length);
      photos[slotKey] = saveApprovalPhotos(filesByField[field], `${po.poNumber}_${req.params.stage}_${slotKey}`);
    });

    /* Photos copied forward from a previous PO of the same SKU arrive as
     * URLs rather than files - they're already stored, so the reference is
     * kept instead of writing a duplicate image. Only URLs that look like
     * our own approval-photo paths are accepted, so this can't be used to
     * point a report at an arbitrary external image. */
    const carried = (data && data.carriedPhotos) || {};
    Object.keys(carried).forEach((slotKey) => {
      const safe = (carried[slotKey] || [])
        .filter((u) => typeof u === 'string' && /^\/approval-photos\/[A-Za-z0-9._%-]+$/.test(u));
      if (!safe.length) return;
      photos[slotKey] = [...safe, ...(photos[slotKey] || [])];
    });
    if (data) delete data.carriedPhotos;

    const entry = approvalStore.updateStage(po.poNumber, po.sku, stageKey, { ...data, photos });

    // If this Sample Approval established an apparel sizing standard, write it
    // back onto the PO record so future POs of the same SKU can find and copy
    // it forward automatically (see orderManagementStore.getEstablishedFitForSku). Records
    // only the sizes actually submitted here, not the fit's entire generic
    // range - a Sample covering 3 sizes shouldn't make a future PO of the
    // same SKU default to all 12 of the fit's possible sizes.
    if (req.params.stage === 'sample' && po.category === 'apparel' && data.sizing && data.sizing.fit) {
      const fitDef = fits.fits[data.sizing.fit];
      if (fitDef) {
        const submittedSizes = (data.sizing.sizeRows || []).map((r) => r.size).filter(Boolean);
        orderManagementStore.updateOrder(po.id, { fitKey: data.sizing.fit, fitSizes: submittedSizes }, 'System', 'Established apparel fit');
      }
    }

    // Keep the Order Management record in sync the other direction too: if
    // the Sample stage was submitted with a risk or factory code different
    // from what's on the PO (e.g. QA adjusted it during approval), write it
    // back so the two sections never show conflicting values.
    if (req.params.stage === 'sample') {
      const syncPatch = {};
      if (data.productRisk && data.productRisk !== po.productRisk) syncPatch.productRisk = data.productRisk;
      if (data.factoryCode && data.factoryCode !== po.factoryCode) syncPatch.supplier = { code: data.factoryCode };
      if (Object.keys(syncPatch).length) {
        orderManagementStore.updateOrder(po.id, syncPatch, 'System', 'Synced from Sample Approval');
      }
    }

    res.json({ ok: true, approval: entry });

    // Best-effort Asana sync: mark this stage "Waiting for Product Dev" the
    // moment China's photos land, so PD sees it needs their attention
    // without having to check this app. Never blocks or fails the response
    // above - fired after responding, errors are just logged.
    if (po.asanaTaskGid) {
      const fieldMap = loadAsanaFieldMap();
      const stageMap = fieldMap[req.params.stage];
      const optionGid = stageMap && stageMap.statusOptions && stageMap.statusOptions.submitted;
      if (stageMap && stageMap.fieldGid && optionGid) {
        asanaClient.setEnumCustomField(po.asanaTaskGid, stageMap.fieldGid, optionGid);
      }
    }
  } catch (err) {
    console.error('Failed to save approval stage:', err);
    res.status(500).json({ error: 'Failed to save approval stage', detail: String(err.message || err) });
  }
});

/** Deliberately bypass Pre-Production Approval - for repeat POs of an
 *  already-established product, where the team typically goes straight
 *  from Golden Sample to Bulk. Only Pre-Production can be skipped; Sample
 *  and Bulk are always required. */
app.post('/api/approval/:poNumber/:stage/skip', (req, res) => {
  try {
    if (req.params.stage !== 'preProduction') {
      return res.status(400).json({ error: 'Only the Pre-Production stage can be skipped' });
    }
    const po = orderManagementStore.toQaShape(orderManagementStore.getOrderByPoNumber(req.params.poNumber));
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    const entry = approvalStore.skipStage(po.poNumber, 'preProductionApproval');
    res.json({ ok: true, approval: entry });

    // Best-effort Asana sync: mark this stage Not Applicable, matching the
    // deliberate "skip" decision made here.
    if (po.asanaTaskGid) {
      const fieldMap = loadAsanaFieldMap();
      const stageMap = fieldMap.preProduction;
      const optionGid = stageMap && stageMap.statusOptions && stageMap.statusOptions.notApplicable;
      if (stageMap && stageMap.fieldGid && optionGid) {
        asanaClient.setEnumCustomField(po.asanaTaskGid, stageMap.fieldGid, optionGid);
      }
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to skip stage' });
  }
});

app.post('/api/approval/:poNumber/:stage/comment', upload.any(), (req, res) => {
  try {
    const stageKey = STAGE_KEY_MAP[req.params.stage];
    if (!stageKey) return res.status(400).json({ error: 'Unknown approval stage' });
    const text = ((req.body && req.body.text) || '').trim();
    const author = ((req.body && req.body.author) || '').trim();
    const approvalStatus = ((req.body && req.body.approvalStatus) || '').trim();
    // A comment can optionally point at one specific photo or size row from
    // this stage's own submission, so a reply can say "see this" instead of
    // describing it in words - see the "reference" picker in the reply form.
    let reference = null;
    if (req.body && req.body.reference) {
      try { reference = JSON.parse(req.body.reference); } catch { reference = null; }
    }
    if (!author) return res.status(400).json({ error: 'author is required' });
    // Only the formal first decision uses the Product Development Lead
    // dropdown - replies are free text for either team, so don't add those.
    if (approvalStatus) addNewOptionIfMissing('productDevelopmentLeads', author);

    const photos = saveApprovalPhotos(req.files, `${req.params.poNumber}_${req.params.stage}_comment`);
    const entry = approvalStore.addPdComment(req.params.poNumber, stageKey, { text, author, approvalStatus, photos, reference });
    if (!entry) return res.status(404).json({ error: 'Purchase order not found' });

    // Production only moves past an inspection stage once PD signs off, so
    // a decision here (not the report being finished) is what advances the
    // order. "Approved with issues flagged" still counts as approval.
    if (approvalStatus && approvalStore.isPdApproved(approvalStore.pdApprovalStatusForStage(entry[stageKey]))) {
      const advanced = orderManagementStore.advanceOnPdApproval(req.params.poNumber, stageKey, author || 'Product Development');
      if (advanced) syncOrderToAsana(advanced, req);
    }

    res.json({ ok: true, approval: entry });

    // Best-effort Asana sync: a formal decision (Approved, Approved with
    // Comments, Minor Issue, Major/Critical) moves this stage's field to
    // match. Free-text replies with no status attached don't touch Asana.
    if (approvalStatus) {
      const po = orderManagementStore.toQaShape(orderManagementStore.getOrderByPoNumber(req.params.poNumber));
      if (po && po.asanaTaskGid) {
        const fieldMap = loadAsanaFieldMap();
        const stageMap = fieldMap[req.params.stage];
        const optionGid = stageMap && stageMap.statusOptions && stageMap.statusOptions[approvalStatus];
        if (stageMap && stageMap.fieldGid && optionGid) {
          asanaClient.setEnumCustomField(po.asanaTaskGid, stageMap.fieldGid, optionGid);
        }

        // Once Bulk is fully approved, the PO's journey is done - attach
        // the final consolidated report (every stage, every inspection)
        // directly to the Asana task so it's on record there too, without
        // anyone needing to come back to this app to find it.
        if (req.params.stage === 'bulk' && approvalStatus === 'approved') {
          (async () => {
            try {
              const fullApproval = approvalStore.getByPoNumber(po.poNumber);
              const reportingHistory = submissionLog.findPriorReportsByPoNumber(po.poNumber);
              const buffer = await buildConsolidatedReport(po, fullApproval, reportingHistory, i18n);
              await asanaClient.attachFileToTask(po.asanaTaskGid, buffer, `${po.poNumber}_Consolidated_Report.pdf`, 'application/pdf');
            } catch (err) {
              console.error(`Failed to attach consolidated report to Asana task for ${po.poNumber}:`, err.message || err);
            }
          })();
        }
      }
    }
  } catch (err) {
    console.error('Failed to save PD comment:', err);
    res.status(500).json({ error: 'Failed to save PD comment', detail: String(err.message || err) });
  }
});

// ---- Reports: consolidated PDF combining PO info, every QA/QC Approval
// stage, and every Reporting-side inspection for that PO ----
const { buildConsolidatedReport } = require('./lib/consolidatedReportBuilder');

app.get('/api/reports/by-sku/:sku', (req, res) => {
  try {
    res.json({ pos: orderManagementStore.getOrdersBySku(req.params.sku).map(orderManagementStore.toQaShape) });
  } catch (err) {
    console.error('Failed to look up POs by SKU:', err);
    res.status(500).json({ error: 'Failed to look up POs by SKU', detail: String(err.message || err) });
  }
});

app.get('/api/consolidated-report/:poNumber', async (req, res) => {
  try {
    const po = orderManagementStore.toQaShape(orderManagementStore.getOrderByPoNumber(req.params.poNumber));
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    const approval = approvalStore.getByPoNumber(po.poNumber);
    const reportingHistory = submissionLog.findPriorReportsByPoNumber(po.poNumber);

    const buffer = await buildConsolidatedReport(po, approval, reportingHistory, i18n);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${po.poNumber}_Consolidated_Report.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('Failed to build consolidated report:', err);
    res.status(500).json({ error: 'Failed to build consolidated report', detail: String(err.message || err) });
  }
});

// ---- One-time migration: Factory Codes -> Suppliers ----
// Factory Codes used to be a flat editable list in Settings. They now live
// as bare Supplier records instead (name only, other fields blank - fill
// them in from the Suppliers page as time allows). Runs on every startup
// but is idempotent: only creates a supplier for a factory code that isn't
// already present as a supplier name, so re-running is harmless.
function migrateFactoryCodesToSuppliers() {
  try {
    const options = loadOptions();
    const factoryCodes = options.factoryCodes || [];
    if (!factoryCodes.length) return;
    const suppliers = supplierStore.listSuppliers();
    const existingCodes = new Set(suppliers.map((s) => (s.vendorCode || '').trim().toLowerCase()).filter(Boolean));
    const existingNames = new Set(suppliers.map((s) => s.name.trim().toLowerCase()));
    let migrated = 0;
    factoryCodes.forEach((code) => {
      const trimmed = String(code).trim();
      const key = trimmed.toLowerCase();
      // Skip if this code is already represented either as a real vendor
      // code (the common case now that the richer vendor seed runs first)
      // or, for older bare entries, as a plain name.
      if (!trimmed || existingCodes.has(key) || existingNames.has(key)) return;
      // Vendor code is the real identifier here - name is a placeholder
      // (the code itself) until the actual factory name is filled in.
      supplierStore.createSupplier({ id: uuidv4(), name: trimmed, vendorCode: trimmed });
      existingCodes.add(key);
      existingNames.add(key);
      migrated += 1;
    });
    if (migrated) console.log(`Migrated ${migrated} factory code(s) into Suppliers as bare records.`);
  } catch (err) {
    console.error('Factory code -> Supplier migration failed:', err);
  }
}
// (migrateFactoryCodesToSuppliers call moved below seedVendorsFromFile - see
// there for why order matters)

// ---- One-time seed: real vendor list pulled from Juniper_Factories.xlsx ----
// Idempotent by vendor code, same as the factory-code migration above - safe
// to run on every startup, only fills in vendors that aren't already there.
function seedVendorsFromFile() {
  try {
    const seedPath = path.join(__dirname, 'seeds', 'vendorSeed.json');
    if (!fs.existsSync(seedPath)) return;
    const vendors = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const existingCodes = new Set(
      supplierStore.listSuppliers().map((s) => (s.vendorCode || '').trim().toLowerCase()).filter(Boolean)
    );
    let added = 0;
    vendors.forEach((v) => {
      const code = (v.vendorCode || '').trim().toLowerCase();
      if (code && existingCodes.has(code)) return;
      supplierStore.createSupplier({ ...v, id: uuidv4() });
      if (code) existingCodes.add(code);
      added += 1;
    });
    if (added) console.log(`Seeded ${added} vendor(s) from Juniper_Factories.xlsx into Suppliers.`);
  } catch (err) {
    console.error('Vendor seed import failed:', err);
  }
}
seedVendorsFromFile();

// ---- One-time seed: full fabric swatch book imported from
// Fabric_Swatch_Translation_-_Data_Export.xlsx (all six tabs). Idempotent
// by seedKey (each entry's position in the source workbook), so restarts
// never duplicate - and duplicate pantones across books are expected and
// preserved as separate entries. Entries seeded by the earlier tab-1-only
// import (identifiable by their old-format blend "65% 35%" and no seedKey)
// get upgraded in place with the richer per-row blend/weight/type data
// rather than duplicated. Image files ship in seeds/fabric-swatches/ and
// get copied onto the persistent disk the first time they're needed.
function seedFabricSwatchesFromFile() {
  try {
    const seedDir = path.join(__dirname, 'seeds', 'fabric-swatches');
    const seedJson = path.join(seedDir, 'fabric-swatches.json');
    if (!fs.existsSync(seedJson)) {
      // Loud on purpose: the most likely reason this file is missing is the
      // seeds/fabric-swatches folder not making it into the deployment
      // (e.g. a zip extracted one level too deep, or a partial copy).
      console.warn(`Fabric swatch seed skipped: ${seedJson} not found. If the Fabric Library is unexpectedly empty, make sure seeds/fabric-swatches/ (1 JSON + swatch images) is committed and deployed.`);
      return;
    }
    const seed = JSON.parse(fs.readFileSync(seedJson, 'utf8'));

    /* A seed marked `replacesAll` supersedes every previously seeded entry
     * rather than merging with it - the older import carried no factory
     * codes, so those records can't identify a colour to a factory and
     * would sit alongside the new ones as duplicates.
     *
     * Only auto-imported records (those with a seedKey) are removed;
     * anything the team added by hand is left alone. Guarded by a marker
     * file so it happens exactly once, not on every restart.
     */
    if (seed.replacesAll) {
      const marker = path.join(submissionLog.DATA_DIR,
        `.fabric-seed-purged-${seed.purgeVersion || 'v1'}`);
      if (!fs.existsSync(marker)) {
        const stale = fabricLibraryStore.listFabricCodes()
          .filter((c) => c.seedKey && !String(c.seedKey).startsWith('sw3_'));
        stale.forEach((c) => fabricLibraryStore.deleteFabricCode(c.id));
        fs.mkdirSync(submissionLog.DATA_DIR, { recursive: true });
        fs.writeFileSync(marker, new Date().toISOString());
        if (stale.length) {
          console.log(`Fabric library: removed ${stale.length} previously seeded swatches, replaced by ${(seed.entries || []).length} with factory codes.`);
        }
      }
    }

    const existing = fabricLibraryStore.listFabricCodes();
    const seededKeys = new Set(existing.map((c) => c.seedKey).filter(Boolean));
    // Old-format tab-1 entries from the previous import, matchable by
    // pantone + book code (unique within that tab).
    const legacy = new Map();
    existing.forEach((c) => {
      if (!c.seedKey && c.materialBlend === '65% 35%') {
        legacy.set(`${(c.pantone || '').toLowerCase()}|${(c.bookCode || '').toLowerCase()}`, c);
      }
    });
    const copyIn = (fname) => {
      if (!fname) return '';
      const src = path.join(seedDir, fname);
      if (!fs.existsSync(src)) return '';
      fs.mkdirSync(FABRIC_LIBRARY_FILES_DIR, { recursive: true });
      const dest = path.join(FABRIC_LIBRARY_FILES_DIR, fname);
      if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
      return `/fabric-library-files/${encodeURIComponent(fname)}`;
    };
    let added = 0, upgraded = 0, renamed = 0;
    // Derive a general color name from a hex value (broad buckets on
    // purpose - "purple", not "lilac") for the display value below.
    const hexToGeneralColor = (hex) => {
      const clean = String(hex || '').trim().replace('#', '');
      if (!/^[0-9a-fA-F]{6}$/.test(clean)) return '';
      const r = parseInt(clean.slice(0, 2), 16) / 255, g = parseInt(clean.slice(2, 4), 16) / 255, b = parseInt(clean.slice(4, 6), 16) / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
      const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
      let h = 0;
      if (d !== 0) {
        if (max === r) h = 60 * (((g - b) / d) % 6);
        else if (max === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
      }
      if (h < 0) h += 360;
      if (l < 0.09) return 'black';
      if (l > 0.93 && s < 0.2) return 'white';
      if (s < 0.12) return 'gray';
      if (h >= 15 && h < 48 && l < 0.42) return 'brown';
      if (h < 15 || h >= 337) return 'red';
      if (h < 42) return 'orange';
      if (h < 68) return 'yellow';
      if (h < 160) return 'green';
      if (h < 200) return 'teal';
      if (h < 258) return 'blue';
      if (h < 300) return 'purple';
      return 'pink';
    };
    // Display value convention for imported swatches, matching how fabric
    // info reads in the manufacturing team's system: "Company Name, GSM,
    // Book Code, Color". No company names in the source workbook yet, so
    // that segment stays blank for now; weights that aren't a simple
    // "NNN gsm" (one tab lists several) stay in the Fabric Weight column
    // only, since embedding their commas here would garble the format.
    const displayValue = (e) => {
      // A swatch is identified by its full code - Pantone, factory book and
      // colour number - so that leads. Anything else is secondary.
      if (e.factoryCode) {
        return [e.pantone, e.factoryCode, e.bookCode].filter(Boolean).join(' - ');
      }
      const gsmMatch = String(e.fabricWeight || '').match(/^(\d+)\s*gsm$/i);
      const gsm = gsmMatch ? `${gsmMatch[1]}gsm` : '';
      const color = hexToGeneralColor(e.hex);
      const parts = [e.companyName, gsm, e.bookCode, color].filter(Boolean);
      return parts.length ? parts.join(', ') : (e.pantone || e.materialBlend || '');
    };
    // Prior auto-generated conventions, for telling "still auto-named"
    // apart from manually edited values during the rename migration.
    const priorConventions = (e) => [
      e.pantone || '',
      [e.bookCode, e.materialBlend].filter(Boolean).join(' - ') || (e.pantone || '')
    ];
    const existingBySeedKey = new Map(existing.filter((c) => c.seedKey).map((c) => [c.seedKey, c]));
    (seed.entries || []).forEach((e) => {
      if (seededKeys.has(e.seedKey)) {
        // Already imported - but rename entries still carrying an older
        // auto-generated convention (pantone-as-value, or "Book - Blend")
        // to the current one, leaving manually edited values alone.
        const stored = existingBySeedKey.get(e.seedKey);
        if (stored && priorConventions(e).includes(stored.value) && displayValue(e) !== stored.value) {
          fabricLibraryStore.updateFabricCode(stored.id, { value: displayValue(e), colorName: hexToGeneralColor(e.hex) });
          renamed += 1;
        }
        return;
      }
      const fields = {
        value: displayValue(e),
        materialBlend: e.materialBlend || '',
        companyName: e.companyName || '',
        colorName: hexToGeneralColor(e.hex),
        swatchUrl: copyIn(e.swatchFile),
        digitalColorUrl: copyIn(e.digitalColorFile),
        pantone: e.pantone || '',
        hex: e.hex || '',
        cmyk: e.cmyk || '',
        factoryCode: e.factoryCode || '',
        bookCode: e.bookCode || '',
        fabricWeight: e.fabricWeight || '',
        garmentType: e.garmentType || '',
        seedKey: e.seedKey || ''
      };
      const legacyMatch = e.seedKey && e.seedKey.startsWith('t1_')
        ? legacy.get(`${(e.pantone || '').toLowerCase()}|${(e.bookCode || '').toLowerCase()}`)
        : null;
      if (legacyMatch) {
        // Keep the existing record (and any notes added to it) - just fill
        // in the richer fields from the full export, including the new
        // "Book - Blend" display value if the old pantone one is still set.
        fabricLibraryStore.updateFabricCode(legacyMatch.id, {
          value: priorConventions(e).includes(legacyMatch.value) ? fields.value : legacyMatch.value,
          materialBlend: fields.materialBlend,
          colorName: fields.colorName,
          fabricWeight: fields.fabricWeight,
          garmentType: fields.garmentType,
          seedKey: fields.seedKey,
          swatchUrl: legacyMatch.swatchUrl || fields.swatchUrl,
          digitalColorUrl: legacyMatch.digitalColorUrl || fields.digitalColorUrl
        });
        upgraded += 1;
      } else {
        fabricLibraryStore.createFabricCode({ id: uuidv4(), ...fields });
        added += 1;
      }
      seededKeys.add(e.seedKey);
    });
    if (added || upgraded || renamed) console.log(`Fabric Library seed: ${added} added, ${upgraded} upgraded, ${renamed} renamed to the "Company, GSM, Book Code, Color" convention.`);
  } catch (err) {
    console.error('Fabric swatch seed import failed:', err);
  }
}
seedFabricSwatchesFromFile();

// Surface the Google callback config at boot so a mismatch is visible in the
// Render logs without having to hit an endpoint.
if (googleAuth.isConfigured()) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  console.log(
    'Google sign-in enabled. Redirect URI must be registered in Google Cloud as: ' +
    (base ? `${base}/auth/google/callback`
          : '<your-public-url>/auth/google/callback  (set PUBLIC_BASE_URL to pin this exactly)')
  );
  console.log(`Google allowed domains: ${googleAuth.allowedDomains().join(', ') || '(none - restriction off)'}`);
}

// Runs after the vendor seed on purpose: several factory codes are also
// real vendor codes in that seed, and this migration only checks by name
// (not vendor code), so running it first would create a shallow duplicate
// (name=code, everything else blank) that beats the real, richer vendor
// record to the punch. Running it second means those codes are already
// properly represented and get skipped; only genuinely unmatched factory
// codes still get a bare placeholder.
migrateFactoryCodesToSuppliers();

// ---- Scheduled weekly backup ----
// Same zip contents as the manual "Download Backup" button, but written to
// disk automatically so a backup exists even if nobody remembers to click
// download. Excludes its own folder from the archive so weekly backups
// don't nest inside each other and balloon in size over time.
const SCHEDULED_BACKUP_DIR = path.join(submissionLog.DATA_DIR, 'scheduled-backups');
const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SCHEDULED_BACKUPS = 8; // ~2 months of weekly snapshots

function listScheduledBackups() {
  if (!fs.existsSync(SCHEDULED_BACKUP_DIR)) return [];
  return fs.readdirSync(SCHEDULED_BACKUP_DIR)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const stat = fs.statSync(path.join(SCHEDULED_BACKUP_DIR, f));
      return { filename: f, createdAt: stat.mtime.toISOString(), sizeBytes: stat.size };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function pruneScheduledBackups() {
  const backups = listScheduledBackups();
  backups.slice(MAX_SCHEDULED_BACKUPS).forEach((b) => {
    try { fs.unlinkSync(path.join(SCHEDULED_BACKUP_DIR, b.filename)); } catch (e) { /* best-effort */ }
  });
}

async function runScheduledBackupIfDue() {
  try {
    const existing = listScheduledBackups();
    const last = existing[0];
    if (last && (Date.now() - new Date(last.createdAt).getTime()) < BACKUP_INTERVAL_MS) return;
    fs.mkdirSync(SCHEDULED_BACKUP_DIR, { recursive: true });
    const filename = `weekly-backup-${new Date().toISOString().slice(0, 10)}.zip`;
    const destPath = path.join(SCHEDULED_BACKUP_DIR, filename);
    const output = fs.createWriteStream(destPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.glob('**/*', { cwd: submissionLog.DATA_DIR, ignore: ['scheduled-backups/**'] });
      archive.finalize();
    });
    pruneScheduledBackups();
    console.log(`Scheduled backup created: ${filename}`);
  } catch (err) {
    console.error('Scheduled backup failed:', err);
  }
}
runScheduledBackupIfDue();
setInterval(runScheduledBackupIfDue, 24 * 60 * 60 * 1000); // check daily, only acts once 7 days have passed

app.get('/api/backup/scheduled', (req, res) => {
  res.json({ backups: listScheduledBackups() });
});
app.get('/api/backup/scheduled/:filename', (req, res) => {
  const filePath = path.join(SCHEDULED_BACKUP_DIR, req.params.filename);
  if (!filePath.startsWith(SCHEDULED_BACKUP_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  res.download(filePath);
});

app.listen(PORT, () => {
  console.log(`Juniper QA/QC app listening on port ${PORT}`);
});
