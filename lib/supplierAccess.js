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

/* ------------------------------------------------------------------ *
 * PD approval links
 *
 * Same idea as the supplier links above, but scoped to ONE purchase order
 * rather than a supplier: PD and QA staff open the approval page for that
 * PO without an account. Useful because approvals often involve people
 * (creators, external QA) who shouldn't have a Juniper login.
 *
 * The link grants approval read/write on that single order and nothing
 * else - no order list, no costs, no other POs.
 * ------------------------------------------------------------------ */

/** Issue or re-issue an order's approval token. */
function rotateApprovalToken(orderStore, orderId, actor) {
  const token = generateToken();
  return orderStore.updateOrder(orderId, {
    approvalAccessToken: token,
    approvalAccessTokenIssuedAt: new Date().toISOString()
  }, actor || 'System', 'Approval link generated');
}

function revokeApprovalToken(orderStore, orderId, actor) {
  return orderStore.updateOrder(orderId, {
    approvalAccessToken: '',
    approvalAccessTokenIssuedAt: null
  }, actor || 'System', 'Approval link revoked');
}

/** Resolve an approval token to its order, comparing in constant time. */
function orderForApprovalToken(orderStore, token) {
  const candidate = String(token || '');
  if (!candidate) return null;
  const buf = Buffer.from(candidate);
  return orderStore.listOrders({}).find((o) => {
    if (!o.approvalAccessToken) return false;
    const stored = Buffer.from(String(o.approvalAccessToken));
    return stored.length === buf.length && crypto.timingSafeEqual(stored, buf);
  }) || null;
}

function approvalLinkFor(baseUrl, order) {
  if (!order || !order.approvalAccessToken) return '';
  return `${String(baseUrl || '').replace(/\/$/, '')}/a/${encodeURIComponent(order.approvalAccessToken)}`;
}

/** Make sure an order has an approval token before we try to share it. */
function ensureApprovalToken(orderStore, orderId, actor) {
  const order = orderStore.getOrderById(orderId);
  if (!order) return null;
  if (order.approvalAccessToken) return order;
  return rotateApprovalToken(orderStore, orderId, actor);
}

module.exports = {
  generateToken, rotateToken, revokeToken, supplierForToken, linkFor, ensureToken,
  rotateApprovalToken, revokeApprovalToken, orderForApprovalToken, approvalLinkFor, ensureApprovalToken
};
