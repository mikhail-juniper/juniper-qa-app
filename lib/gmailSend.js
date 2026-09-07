/**
 * Sending email as the signed-in user, through the Gmail API.
 *
 * Why the API and not SMTP: the narrow `gmail.send` scope only works with
 * the HTTP Gmail API. SMTP auth would require the full `mail.google.com`
 * scope, which is Restricted and drags in an annual third-party security
 * audit. `gmail.send` is merely Sensitive, and on an Internal (Workspace-
 * only) consent screen needs no verification at all.
 *
 * The practical payoff: the message really is from the person who sent it.
 * It lands in their Gmail Sent folder and replies go back to them, rather
 * than to a shared no-reply address.
 *
 * Consent is incremental - `gmail.send` is NOT bundled into ordinary
 * sign-in, so nobody is asked to grant send access just to log in. They
 * connect Gmail separately, the first time they want to send from the app.
 */
const crypto = require('crypto');

const TOKEN_ENDPOINT = process.env.GOOGLE_TOKEN_ENDPOINT || 'https://oauth2.googleapis.com/token';
const SEND_ENDPOINT = process.env.GMAIL_SEND_ENDPOINT || 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/* ---- Refresh-token storage ----
 * A refresh token is a long-lived credential, so it's encrypted at rest
 * rather than sitting in plain text in users.json. Key is derived from
 * SESSION_SECRET; if that changes, stored grants simply stop decrypting and
 * the user reconnects Gmail - which is the safe failure direction.
 */
function encryptionKey() {
  const secret = process.env.SESSION_SECRET || process.env.SITE_PASSWORD || 'juniper-dev-secret';
  return crypto.createHash('sha256').update(`${secret}::gmail-token`).digest();
}

function encryptToken(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

function decryptToken(stored) {
  if (!stored || !String(stored).startsWith('v1.')) return '';
  try {
    const [, ivB64, tagB64, dataB64] = String(stored).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  } catch (err) {
    // Wrong key or tampered value - treat as "not connected".
    console.error('Could not decrypt a stored Gmail token; user must reconnect.');
    return '';
  }
}

/** Trade a stored refresh token for a short-lived access token. */
async function accessTokenFor(refreshToken) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // A revoked or expired grant shows up here; surface it as reconnectable.
    const err = new Error('Gmail access has expired. Please reconnect Gmail.');
    err.needsReconnect = true;
    err.detail = detail;
    throw err;
  }
  const body = await res.json();
  return body.access_token;
}

/**
 * RFC 2047 encoded-word for a header value. Subjects here are routinely
 * Chinese, which is not valid raw in a mail header.
 */
function encodeHeader(value) {
  const str = String(value || '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(str)) return str; // plain ASCII needs no encoding
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

/** A display name + address pair, quoted safely. */
function formatAddress(name, email) {
  if (!email) return '';
  if (!name) return email;
  return `${encodeHeader(name)} <${email}>`;
}

/**
 * Build the raw MIME message. UTF-8 base64 body, so Chinese content and
 * long lines survive intact rather than being mangled by line-length rules.
 */
function buildMime({ to, from, fromName, subject, body, replyTo }) {
  const headers = [
    `To: ${to}`,
    `From: ${formatAddress(fromName, from)}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64'
  ].filter(Boolean);
  const encodedBody = Buffer.from(String(body || ''), 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n'); // wrap per RFC 2045
  return `${headers.join('\r\n')}\r\n\r\n${encodedBody}`;
}

/**
 * Send one message as the owner of `refreshToken`. Returns Gmail's message
 * id on success. Throws with `needsReconnect` set when the grant is no
 * longer usable, so callers can prompt rather than just failing.
 */
async function sendAs(refreshToken, message) {
  if (!refreshToken) {
    const err = new Error('Gmail is not connected for this account.');
    err.needsReconnect = true;
    throw err;
  }
  const accessToken = await accessTokenFor(refreshToken);
  const raw = Buffer.from(buildMime(message), 'utf8').toString('base64url');
  const res = await fetch(SEND_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      const err = new Error('Gmail rejected the request. Please reconnect Gmail.');
      err.needsReconnect = true;
      err.detail = detail;
      throw err;
    }
    throw new Error(`Gmail send failed (${res.status}): ${detail}`);
  }
  const body = await res.json();
  return body.id;
}

module.exports = {
  GMAIL_SEND_SCOPE, encryptToken, decryptToken, accessTokenFor,
  buildMime, encodeHeader, formatAddress, sendAs
};
