/**
 * Per-supplier access links.
 *
 * A factory shouldn't have to hold an account to look at the POs we've sent
 * them. Each supplier gets one long random token; the link that carries it
 * grants a read-only, supplier-scoped session and drops them straight on
 * their order page.
 *
 * Security posture - worth being explicit, because this trades some
 * strictness for a lot of usability:
 *   - The link IS the credential. Anyone holding it sees that supplier's
 *     POs. That's the same property as a password-reset or calendar-invite
 *     link, and the reason the supplier view is redacted server-side.
 *   - Tokens are 32 random bytes, so they can't be guessed.
 *   - They're revocable and regenerable per supplier: rotating one instantly
 *     kills every previously shared link for that factory.
 *   - The session it issues is read-only supplier scope - it can't write
 *     anything, and can't see another supplier's data.
 *   - Optional expiry, off by default, since a PO can be open for months.
 */
const crypto = require('crypto');
const supplierStore = require('./supplierStore');

/** 32 bytes, URL-safe. Long enough that guessing isn't a concern. */
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Issue (or re-issue) a supplier's access token, replacing any existing
 *  one. Returns the updated supplier record. */
function rotateToken(supplierId) {
  const token = generateToken();
  return supplierStore.updateSupplier(supplierId, {
    accessToken: token,
    accessTokenIssuedAt: new Date().toISOString()
  });
}

/** Remove a supplier's token, invalidating every link already sent. */
function revokeToken(supplierId) {
  return supplierStore.updateSupplier(supplierId, {
    accessToken: '',
    accessTokenIssuedAt: null
  });
}

/**
 * Resolve a token to its supplier. Uses a constant-time comparison against
 * each candidate so a near-miss token can't be narrowed down by timing.
 */
function supplierForToken(token) {
  const candidate = String(token || '');
  if (!candidate) return null;
  const buf = Buffer.from(candidate);
  return supplierStore.listSuppliers().find((s) => {
    if (!s.accessToken) return false;
    const stored = Buffer.from(String(s.accessToken));
    return stored.length === buf.length && crypto.timingSafeEqual(stored, buf);
  }) || null;
}

/** The full link to hand a supplier. */
function linkFor(baseUrl, supplier) {
  if (!supplier || !supplier.accessToken) return '';
  return `${String(baseUrl || '').replace(/\/$/, '')}/s/${encodeURIComponent(supplier.accessToken)}`;
}

/** Ensure a supplier has a token, creating one on first use so sending a PO
 *  never fails just because nobody pressed "generate" first. */
function ensureToken(supplierId) {
  const supplier = supplierStore.getSupplier(supplierId);
  if (!supplier) return null;
  if (supplier.accessToken) return supplier;
  return rotateToken(supplierId);
}

module.exports = { generateToken, rotateToken, revokeToken, supplierForToken, linkFor, ensureToken };
