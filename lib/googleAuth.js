/**
 * Google sign-in for Juniper staff.
 *
 * Implemented directly against Google's OAuth2 endpoints rather than pulling
 * in a library: the authorization-code flow is three HTTP calls, and this
 * app has no build step for native deps.
 *
 * The id_token isn't verified locally (that would need JWKS fetching and a
 * JWT library). Instead the access token is exchanged for the profile from
 * Google's own userinfo endpoint over TLS - we trust the response because we
 * trust the connection to accounts.google.com, which is the same trust
 * anchor signature verification would give us here.
 *
 * Setup (see README): create an OAuth client at console.cloud.google.com,
 * then set
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_ALLOWED_DOMAIN   optional - restrict to your Workspace domain
 *   PUBLIC_BASE_URL         optional - overrides the detected callback host
 * With no client id set, the whole feature stays dormant and the button
 * doesn't appear.
 */
const crypto = require('crypto');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/**
 * Allowed Workspace domains. Accepts a comma- (or space-) separated list,
 * because a company often has more than one domain - e.g.
 *   GOOGLE_ALLOWED_DOMAIN=hellojuniper.com, junipercreates.com
 * Returns [] when unset, which means "no domain restriction".
 */
function allowedDomains() {
  return String(process.env.GOOGLE_ALLOWED_DOMAIN || '')
    .split(/[,\s]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

/**
 * Always-admin addresses, baked in so the owner's account is never left
 * without admin because an env var was missed on a fresh deployment.
 */
const BUILT_IN_ADMIN_EMAILS = ['mikhail@junipercreates.com'];

/**
 * Emails that should get the admin role when auto-provisioned. The built-in
 * list above, plus anything in
 *   GOOGLE_ADMIN_EMAILS=someone@hellojuniper.com, other@junipercreates.com
 * Env entries ADD to the built-ins rather than replacing them.
 *
 * Only applied when an account is FIRST created - it never re-promotes
 * someone an admin has deliberately demoted, so a role change in the Users
 * page always wins afterwards.
 */
function adminEmails() {
  const fromEnv = String(process.env.GOOGLE_ADMIN_EMAILS || '')
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...BUILT_IN_ADMIN_EMAILS, ...fromEnv])];
}

/** The role a brand-new Google sign-in should get. Juniper Team by default;
 *  admin for anyone in the admin list. */
function defaultRoleFor(email) {
  return adminEmails().includes(String(email || '').trim().toLowerCase()) ? 'admin' : 'internal';
}

/**
 * Should an EXISTING account be forced back to admin on sign-in?
 *
 * True only for the built-in owner address, and deliberately not for
 * GOOGLE_ADMIN_EMAILS. The reasoning: an owner locked out of their own admin
 * (by an earlier sign-in that predated this rule, or by someone editing
 * their role) has no way back in except the shared password. For everyone
 * else, a demotion made in the Users page must stick.
 */
function shouldForceAdmin(email) {
  return BUILT_IN_ADMIN_EMAILS.includes(String(email || '').trim().toLowerCase());
}

/** First allowed domain, or '' - kept for callers that want a single label
 *  (the login button, and Google's `hd` hint which accepts only one). */
function allowedDomain() {
  return allowedDomains()[0] || '';
}

function callbackUrl(req) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')
    || `${req.protocol}://${req.get('host')}`;
  return `${base}/auth/google/callback`;
}

/** Random state value, signed into a short-lived cookie by the caller, to
 *  tie the callback back to the browser that started the flow (CSRF). */
function makeState() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Build the consent URL. `extraScopes` supports incremental consent - the
 * Gmail send permission is requested separately, when someone first wants
 * to send from the app, rather than being bundled into ordinary sign-in.
 */
function authUrl(req, state, extraScopes) {
  const scopes = ['openid', 'email', 'profile', ...(extraScopes || [])];
  const wantsOffline = (extraScopes || []).length > 0;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(req),
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    // A refresh token is only issued with offline access, and Google only
    // returns it again on a forced re-consent - so ask for both when we
    // actually need long-lived send access.
    ...(wantsOffline ? { access_type: 'offline', prompt: 'consent' } : { prompt: 'select_account' }),
    include_granted_scopes: 'true',
    // Ask Google to pre-filter the account picker. `hd` accepts only one
    // domain, so with several configured we skip the hint entirely rather
    // than silently favouring the first - enforcement happens below either
    // way, so this only affects the picker's convenience.
    ...(allowedDomains().length === 1 ? { hd: allowedDomains()[0] } : {})
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** Exchange the authorization code for tokens. */
async function exchangeCode(req, code) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(req),
      grant_type: 'authorization_code'
    })
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}): ${await res.text().catch(() => '')}`);
  }
  return res.json();
}

/** Fetch the signed-in user's profile. */
async function fetchProfile(accessToken) {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`Google userinfo failed (${res.status})`);
  return res.json();
}

/**
 * Is this profile allowed in? Split out from completeSignIn so the rule can
 * be tested without standing up the whole OAuth round trip.
 * With no domains configured, everyone passes (restriction is opt-in).
 */
function isDomainAllowed(email, hd) {
  const domains = allowedDomains();
  if (!domains.length) return true;
  const emailDomain = (String(email || '').split('@')[1] || '').toLowerCase();
  const hdClaim = String(hd || '').toLowerCase();
  return domains.includes(emailDomain) || domains.includes(hdClaim);
}

/**
 * Run the callback half of the flow and return a normalized profile.
 * Throws with a human-readable message on any rejection, which the route
 * turns into a message on the login page.
 */
async function completeSignIn(req, code) {
  const tokens = await exchangeCode(req, code);
  const profile = await fetchProfile(tokens.access_token);

  if (!profile.email) throw new Error('Google did not return an email address.');
  if (!profile.email_verified) throw new Error('That Google account has an unverified email address.');

  // Enforce the domain list here, not just via the `hd` hint above - the
  // hint is only a picker filter and can be bypassed.
  if (!isDomainAllowed(profile.email, profile.hd)) {
    throw new Error(`Only ${allowedDomains().join(' or ')} accounts can sign in here.`);
  }

  return {
    // Tokens are returned alongside the profile so the caller can persist a
    // refresh token when one was issued (the Connect Gmail flow).
    tokens,
    profile: {
      sub: profile.sub,
      email: String(profile.email).trim().toLowerCase(),
      name: profile.name || profile.email,
      picture: profile.picture || ''
    }
  };
}

/** Read-only Drive access, requested separately from sign-in. Restricted
 *  scope: allowed for Internal apps under the internal-use exception, but a
 *  Workspace admin can still block it via API controls - which is exactly
 *  what the connect flow is for finding out. */
const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

module.exports = {
  DRIVE_READONLY_SCOPE,
  isConfigured, allowedDomain, allowedDomains, isDomainAllowed, adminEmails, defaultRoleFor,
  shouldForceAdmin, BUILT_IN_ADMIN_EMAILS,
  callbackUrl, makeState, authUrl,
  exchangeCode, fetchProfile, completeSignIn
};
