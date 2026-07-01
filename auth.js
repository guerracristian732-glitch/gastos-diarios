const crypto = require('crypto');

const SECRET = process.env.COOKIE_SECRET || 'cambia-esta-clave-en-produccion';
const SIETE_DIAS = 7 * 24 * 60 * 60; // segundos

function base64urlEncode(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString();
}

function sign(data) {
  const b64 = base64urlEncode(JSON.stringify(data));
  const hmac = crypto.createHmac('sha256', SECRET).update(b64).digest('hex');
  return `${b64}.${hmac}`;
}

function verify(token) {
  if (!token) return null;
  const partes = token.split('.');
  if (partes.length !== 2) return null;
  const [b64, hmac] = partes;
  const esperado = crypto.createHmac('sha256', SECRET).update(b64).digest('hex');
  if (hmac !== esperado) return null;
  try {
    return JSON.parse(base64urlDecode(b64));
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    cookies[k] = decodeURIComponent(v);
  });
  return cookies;
}

function setSessionCookie(res, data) {
  const token = sign(data);
  res.setHeader('Set-Cookie', `session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SIETE_DIAS}; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function getSession(req) {
  const cookies = parseCookies(req);
  return verify(cookies.session);
}

module.exports = { sign, verify, parseCookies, setSessionCookie, clearSessionCookie, getSession };
