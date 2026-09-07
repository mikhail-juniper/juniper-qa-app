/**
 * WeChat sign-in.
 *
 * Two modes, because which one Juniper can use depends on the account type
 * the China entity holds. Both share the same token and profile endpoints,
 * so only the authorize URL and scope differ - the rest of the app doesn't
 * care which is in play.
 *
 *   mode 'oa'  - Official Account (公众号) web authorization.
 *                Works ONLY inside WeChat's own in-app browser. No ICP
 *                filing needed, just a verified Service Account and the
 *                callback domain configured in the OA admin. This is the
 *                realistic path for the China QA team on phones.
 *
 *   mode 'qr'  - Open Platform (开放平台) website app, desktop QR scan.
 *                Nicer on desktop, but the callback domain must have
 *                completed ICP filing, which needs a mainland-hosted site
 *                and a Chinese entity. Included so switching is a config
 *                change if that ever becomes available.
 *
 * Dormant unless WECHAT_APP_ID and WECHAT_APP_SECRET are set, exactly like
 * the Google integration - no credentials, no button.
 */
const crypto = require('crypto');

const OA_AUTHORIZE = 'https://open.weixin.qq.com/connect/oauth2/authorize';
const QR_AUTHORIZE = 'https://open.weixin.qq.com/connect/qrconnect';
const TOKEN_ENDPOINT = process.env.WECHAT_TOKEN_ENDPOINT
  || 'https://api.weixin.qq.com/sns/oauth2/access_token';
const USERINFO_ENDPOINT = process.env.WECHAT_USERINFO_ENDPOINT
  || 'https://api.weixin.qq.com/sns/userinfo';

function isConfigured() {
  return !!(process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET);
}

/** 'oa' (in-WeChat) or 'qr' (desktop scan). Defaults to Official Account. */
function mode() {
  return String(process.env.WECHAT_MODE || 'oa').trim().toLowerCase() === 'qr' ? 'qr' : 'oa';
}

function callbackUrl(req) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')
    || `${req.protocol}://${req.get('host')}`;
  return `${base}/auth/wechat/callback`;
}

function makeState() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * True when the request is coming from WeChat's built-in browser. Official
 * Account authorization silently fails anywhere else, so the login page
 * uses this to decide whether offering the button would just frustrate
 * someone on a desktop.
 */
function isWeChatBrowser(req) {
  return /MicroMessenger/i.test(String((req.headers && req.headers['user-agent']) || ''));
}

/**
 * Build the consent URL.
 *
 * snsapi_base returns only an OpenID with no prompt at all - ideal for
 * suppliers following a link. snsapi_userinfo shows a consent screen and
 * returns a name and avatar, which is what we want for staff sign-in so the
 * account has something human attached to it.
 */
function authUrl(req, state, opts) {
  const silent = !!(opts && opts.silent);
  const isQr = mode() === 'qr';
  const params = new URLSearchParams({
    appid: process.env.WECHAT_APP_ID,
    redirect_uri: callbackUrl(req),
    response_type: 'code',
    scope: isQr ? 'snsapi_login' : (silent ? 'snsapi_base' : 'snsapi_userinfo'),
    state
  });
  // WeChat requires the literal #wechat_redirect fragment on the OA flow or
  // the authorize page refuses to redirect back.
  return isQr
    ? `${QR_AUTHORIZE}?${params.toString()}#wechat_redirect`
    : `${OA_AUTHORIZE}?${params.toString()}#wechat_redirect`;
}

/**
 * WeChat returns HTTP 200 with an errcode in the body on failure, rather
 * than a non-2xx status - so every response has to be inspected.
 */
async function getJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw new Error(`WeChat returned a non-JSON response: ${text.slice(0, 200)}`);
  }
  if (body.errcode) {
    throw new Error(`WeChat error ${body.errcode}: ${body.errmsg || 'unknown'}`);
  }
  return body;
}

/** Exchange the code for an access token + the user's OpenID. */
async function exchangeCode(code) {
  const params = new URLSearchParams({
    appid: process.env.WECHAT_APP_ID,
    secret: process.env.WECHAT_APP_SECRET,
    code,
    grant_type: 'authorization_code'
  });
  return getJson(`${TOKEN_ENDPOINT}?${params.toString()}`);
}

/** Profile, available only when snsapi_userinfo was granted. */
async function fetchProfile(accessToken, openid) {
  const params = new URLSearchParams({ access_token: accessToken, openid, lang: 'zh_CN' });
  return getJson(`${USERINFO_ENDPOINT}?${params.toString()}`);
}

/**
 * Complete the callback. Returns a normalized identity.
 *
 * unionId is the one to key on where available: it's stable for the same
 * person across every app under the same Open Platform account, whereas
 * openId differs per app. Falling back to openId keeps this working for a
 * standalone Official Account.
 */
async function completeSignIn(code) {
  const tokens = await exchangeCode(code);
  if (!tokens.openid) throw new Error('WeChat did not return an OpenID.');

  let profile = {};
  // snsapi_base grants no profile access; asking anyway would just error.
  if (String(tokens.scope || '').includes('snsapi_userinfo')) {
    try {
      profile = await fetchProfile(tokens.access_token, tokens.openid);
    } catch (err) {
      // A missing display name shouldn't block sign-in.
      console.error('WeChat profile fetch failed (continuing):', err.message || err);
    }
  }

  return {
    openId: tokens.openid,
    unionId: tokens.unionid || profile.unionid || null,
    name: profile.nickname || '',
    avatar: profile.headimgurl || ''
  };
}

module.exports = {
  isConfigured, mode, callbackUrl, makeState, authUrl, isWeChatBrowser,
  exchangeCode, fetchProfile, completeSignIn
};
