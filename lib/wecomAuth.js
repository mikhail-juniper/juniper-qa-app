/**
 * WeCom (企业微信) sign-in.
 *
 * Distinct from lib/wechatAuth.js, which handles consumer WeChat. Different
 * product, different endpoints, and one important difference in trust: a
 * WeCom userid is only issued to a member of the company's own WeCom org.
 * That IS verifiable company membership, so - unlike consumer WeChat - a
 * first-time sign-in can be auto-provisioned, the same way a Google
 * Workspace address is.
 *
 * Two entry points, chosen automatically:
 *   - Inside the WeCom app: the OAuth authorize URL with snsapi_base, which
 *     identifies the member silently with no prompt.
 *   - Anywhere else (desktop browser): the QR-scan SSO login page.
 * Both come back to the same callback with a code, and the code is redeemed
 * the same way, so the rest of the app sees one flow.
 *
 * Dormant unless WECOM_CORP_ID, WECOM_AGENT_ID and WECOM_SECRET are set.
 */
const crypto = require('crypto');

const OAUTH_AUTHORIZE = 'https://open.weixin.qq.com/connect/oauth2/authorize';
const QR_LOGIN = 'https://login.work.weixin.qq.com/wwlogin/sso/login';
const TOKEN_ENDPOINT = process.env.WECOM_TOKEN_ENDPOINT
  || 'https://qyapi.weixin.qq.com/cgi-bin/gettoken';
const USERINFO_ENDPOINT = process.env.WECOM_USERINFO_ENDPOINT
  || 'https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo';
const USERDETAIL_ENDPOINT = process.env.WECOM_USERDETAIL_ENDPOINT
  || 'https://qyapi.weixin.qq.com/cgi-bin/user/get';

function isConfigured() {
  return !!(process.env.WECOM_CORP_ID && process.env.WECOM_AGENT_ID && process.env.WECOM_SECRET);
}

function callbackUrl(req) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')
    || `${req.protocol}://${req.get('host')}`;
  return `${base}/auth/wecom/callback`;
}

function makeState() {
  return crypto.randomBytes(24).toString('base64url');
}

/** WeCom's in-app browser identifies itself with "wxwork" on top of the
 *  usual WeChat MicroMessenger token. */
function isWeComBrowser(req) {
  return /wxwork/i.test(String((req.headers && req.headers['user-agent']) || ''));
}

/**
 * Where to send someone to authenticate. Inside WeCom this is silent;
 * on desktop it's a QR code they scan with the WeCom app.
 */
function authUrl(req, state) {
  const redirect = callbackUrl(req);
  if (isWeComBrowser(req)) {
    const params = new URLSearchParams({
      appid: process.env.WECOM_CORP_ID,
      redirect_uri: redirect,
      response_type: 'code',
      // snsapi_base is enough to get the userid and shows no prompt at all.
      scope: 'snsapi_base',
      agentid: process.env.WECOM_AGENT_ID,
      state
    });
    // The literal fragment is required or WeCom won't redirect back.
    return `${OAUTH_AUTHORIZE}?${params.toString()}#wechat_redirect`;
  }
  const params = new URLSearchParams({
    login_type: 'CorpApp',
    appid: process.env.WECOM_CORP_ID,
    agentid: process.env.WECOM_AGENT_ID,
    redirect_uri: redirect,
    state
  });
  return `${QR_LOGIN}?${params.toString()}`;
}

/** WeCom signals failure with an errcode in a 200 response body. */
async function getJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw new Error(`WeCom returned a non-JSON response: ${text.slice(0, 200)}`);
  }
  if (body.errcode) {
    throw new Error(`WeCom error ${body.errcode}: ${body.errmsg || 'unknown'}`);
  }
  return body;
}

/* Access tokens last ~2 hours and WeCom rate-limits the token endpoint
 * hard, so it's cached in memory and refreshed a minute early. */
let cachedToken = null;
let cachedUntil = 0;

async function accessToken(force) {
  if (!force && cachedToken && Date.now() < cachedUntil) return cachedToken;
  const params = new URLSearchParams({
    corpid: process.env.WECOM_CORP_ID,
    corpsecret: process.env.WECOM_SECRET
  });
  const body = await getJson(`${TOKEN_ENDPOINT}?${params.toString()}`);
  cachedToken = body.access_token;
  cachedUntil = Date.now() + Math.max(0, (Number(body.expires_in) || 7200) - 60) * 1000;
  return cachedToken;
}

/** Clear the cache - used when a call fails on an expired token. */
function resetToken() {
  cachedToken = null;
  cachedUntil = 0;
}

/**
 * Redeem the login code for the member's identity.
 *
 * Retries once with a fresh access token: a cached token can expire between
 * the check and the call, and the whole sign-in shouldn't fail on that.
 */
async function completeSignIn(code) {
  const call = async (token) => {
    const params = new URLSearchParams({ access_token: token, code });
    return getJson(`${USERINFO_ENDPOINT}?${params.toString()}`);
  };

  let info;
  try {
    info = await call(await accessToken());
  } catch (err) {
    if (/4200[01]|42001|40014/.test(err.message)) { // expired/invalid token
      resetToken();
      info = await call(await accessToken(true));
    } else {
      throw err;
    }
  }

  if (!info.userid) {
    // An external contact or someone outside the org gets an openid instead
    // of a userid - they're not a company member and shouldn't be let in.
    throw new Error('That WeChat account is not a member of the Juniper WeCom organisation.');
  }

  // Name lives on a separate endpoint; a missing one shouldn't block login.
  let name = '';
  let email = '';
  try {
    const params = new URLSearchParams({ access_token: await accessToken(), userid: info.userid });
    const detail = await getJson(`${USERDETAIL_ENDPOINT}?${params.toString()}`);
    name = detail.name || '';
    email = (detail.biz_mail || detail.email || '').trim().toLowerCase();
  } catch (err) {
    console.error('WeCom user detail lookup failed (continuing):', err.message || err);
  }

  return { userId: info.userid, name, email };
}

module.exports = {
  isConfigured, callbackUrl, makeState, authUrl, isWeComBrowser,
  accessToken, resetToken, completeSignIn
};
