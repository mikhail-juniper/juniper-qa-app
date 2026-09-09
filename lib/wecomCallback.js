/**
 * WeCom message-callback verification.
 *
 * Why this exists: WeCom refuses to let you configure Trusted IPs until the
 * app has either a verified trusted domain or a configured "receive
 * messages" server URL. The trusted-domain route requires the domain's ICP
 * filing entity to match the company, which an onrender.com subdomain can
 * never satisfy. This is the other door.
 *
 * WeCom verifies the URL by sending a GET with msg_signature, timestamp,
 * nonce and echostr. To pass, we must:
 *   1. Recompute the signature as sha1 of [token, timestamp, nonce, echostr]
 *      sorted lexicographically and concatenated, and match it.
 *   2. AES-decrypt echostr and reply with the plaintext message, nothing else.
 *
 * Getting either step wrong means WeCom rejects the URL with no useful
 * detail, so both are implemented strictly and the pieces are exported for
 * testing rather than buried in a route handler.
 */
const crypto = require('crypto');

function isConfigured() {
  return !!(process.env.WECOM_CALLBACK_TOKEN && process.env.WECOM_CALLBACK_AES_KEY);
}

/**
 * The 32-byte AES key. WeCom gives a 43-character base64 string with the
 * trailing '=' stripped, so it has to be added back before decoding.
 */
function aesKey() {
  const raw = String(process.env.WECOM_CALLBACK_AES_KEY || '').trim();
  const key = Buffer.from(`${raw}=`, 'base64');
  if (key.length !== 32) {
    throw new Error(`WECOM_CALLBACK_AES_KEY must decode to 32 bytes (got ${key.length}). It should be the 43-character key from the WeCom console.`);
  }
  return key;
}

/**
 * sha1 over the four values sorted as strings. The sort is the part people
 * get wrong - it's lexicographic over the raw strings, not a fixed order.
 */
function signature(token, timestamp, nonce, encrypt) {
  const sorted = [String(token), String(timestamp), String(nonce), String(encrypt)].sort();
  return crypto.createHash('sha1').update(sorted.join('')).digest('hex');
}

/** Constant-time comparison, so a wrong signature can't be probed by timing. */
function signatureMatches(expected, provided) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(provided || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Decrypt a WeCom-encrypted payload.
 *
 * Plaintext layout: 16 random bytes, then a 4-byte big-endian length, then
 * the message, then the corpid. Padding is PKCS#7 but Node's auto-unpad
 * rejects some of WeCom's payloads, so it's stripped by hand.
 */
function decrypt(encrypted) {
  const key = aesKey();
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  const raw = Buffer.concat([
    decipher.update(Buffer.from(String(encrypted), 'base64')),
    decipher.final()
  ]);
  // Strip PKCS#7: the last byte says how many padding bytes to remove.
  const pad = raw[raw.length - 1];
  const body = (pad < 1 || pad > 32) ? raw : raw.subarray(0, raw.length - pad);
  const msgLength = body.readUInt32BE(16);
  return {
    message: body.subarray(20, 20 + msgLength).toString('utf8'),
    receiveId: body.subarray(20 + msgLength).toString('utf8')
  };
}

/** Encrypt, used only to build test fixtures for the decrypt path. */
function encrypt(message, receiveId) {
  const key = aesKey();
  const iv = key.subarray(0, 16);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(Buffer.byteLength(message), 0);
  const body = Buffer.concat([
    crypto.randomBytes(16), len, Buffer.from(message, 'utf8'), Buffer.from(receiveId || '', 'utf8')
  ]);
  const padSize = 32 - (body.length % 32);
  const padded = Buffer.concat([body, Buffer.alloc(padSize, padSize)]);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

/**
 * Handle WeCom's GET verification. Returns the plaintext echostr to send
 * back, or throws with a reason.
 */
function verifyUrl({ msg_signature: msgSignature, timestamp, nonce, echostr }) {
  if (!isConfigured()) {
    throw new Error('WECOM_CALLBACK_TOKEN and WECOM_CALLBACK_AES_KEY are not set.');
  }
  if (!msgSignature || !timestamp || !nonce || !echostr) {
    throw new Error('Missing verification parameters.');
  }
  const expected = signature(process.env.WECOM_CALLBACK_TOKEN, timestamp, nonce, echostr);
  if (!signatureMatches(expected, msgSignature)) {
    throw new Error('Signature mismatch - check WECOM_CALLBACK_TOKEN matches the console.');
  }
  return decrypt(echostr).message;
}

module.exports = {
  isConfigured, aesKey, signature, signatureMatches, decrypt, encrypt, verifyUrl
};
