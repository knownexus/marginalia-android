'use strict';
// Marginalia server: serves the single-file page and a small account + library API.
// The server stores one JSON library per account. Merging happens in the client
// (same rules as Import), so the server only needs optimistic concurrency (If-Match).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT) || 8080;
const INVITE_CODE = process.env.INVITE_CODE || '';
const INDEX_PATH = process.env.INDEX_PATH || path.join(__dirname, 'index.html');
const MAX_BODY = 12 * 1024 * 1024;
const MAX_LIBRARY_CHARS = 10_000_000;
const SESSION_DAYS = 90;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const page = fs.readFileSync(INDEX_PATH);

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      pw_salt TEXT NOT NULL,
      pw_hash TEXT NOT NULL,
      created TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS must_reset BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS restricted BOOLEAN NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS libraries (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      rev INTEGER NOT NULL,
      updated TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
}

/* ---------- helpers ---------- */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k.toString('hex'))));
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

const attempts = new Map(); // login/register throttle: key -> {n, reset}
function throttle(key, max) {
  const t = Date.now(), a = attempts.get(key);
  if (!a || a.reset < t) { attempts.set(key, { n: 0, reset: t + 15 * 60 * 1000 }); return; }
  if (a.n >= max) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
}
const fail = key => { const a = attempts.get(key); if (a) a.n++; };
setInterval(() => { const t = Date.now(); for (const [k, v] of attempts) if (v.reset < t) attempts.delete(k); }, 60_000).unref();
const clientIp = req => (req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || '?');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, 'Library is too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, extra = {}) {
  const buf = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store'
  }, extra));
  res.end(buf);
}
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Max-Age': '86400' };

function validName(u) { return typeof u === 'string' && /^[a-z0-9_.-]{3,32}$/.test(u); }
function validPw(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 200; }

// A session created while must_reset is set is "restricted": it can only change the password.
async function newSession(userId, restricted = false) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO sessions(token_hash,user_id,expires,restricted) VALUES($1,$2,now()+$3::interval,$4)', [sha(token), userId, SESSION_DAYS + ' days', restricted]);
  return token;
}
async function auth(req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
  if (!m) throw new HttpError(401, 'Sign in required');
  const r = await pool.query('SELECT u.id, u.username, s.restricted FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires>now()', [sha(m[1])]);
  if (!r.rows[0]) throw new HttpError(401, 'Session expired. Sign in again.');
  return { id: r.rows[0].id, username: r.rows[0].username, restricted: r.rows[0].restricted, tokenHash: sha(m[1]) };
}

/* ---------- routes ---------- */
async function api(req, res, url) {
  const route = req.method + ' ' + url.pathname;
  const body = req.method === 'GET' ? {} : await readBody(req);

  if (route === 'POST /api/register') {
    const ip = clientIp(req); throttle('reg:' + ip, 10); 
    if (!INVITE_CODE) throw new HttpError(403, 'Registration is closed');
    const username = String(body.username || '').trim().toLowerCase();
    if (!safeEq(sha(String(body.invite || '')), sha(INVITE_CODE))) { fail('reg:' + ip); throw new HttpError(403, 'Invite code not recognised'); }
    if (!validName(username)) throw new HttpError(400, 'Username must be 3-32 characters: letters, numbers, . _ -');
    if (!validPw(body.password)) throw new HttpError(400, 'Password must be at least 8 characters');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await scrypt(body.password, salt);
    let id;
    try { id = (await pool.query('INSERT INTO users(username,pw_salt,pw_hash) VALUES($1,$2,$3) RETURNING id', [username, salt, hash])).rows[0].id; }
    catch (e) { if (e.code === '23505') throw new HttpError(409, 'That username is taken'); throw e; }
    return send(res, 200, { username, token: await newSession(id), mustChange: false }, cors);
  }

  if (route === 'POST /api/login') {
    const username = String(body.username || '').trim().toLowerCase(), ip = clientIp(req);
    throttle('ip:' + ip, 40); throttle('user:' + username, 10);
    const r = await pool.query('SELECT id, pw_salt, pw_hash, must_reset FROM users WHERE username=$1', [username]);
    const row = r.rows[0];
    // Always hash, so unknown usernames cost the same as wrong passwords.
    const hash = await scrypt(String(body.password || ''), row ? row.pw_salt : '00'.repeat(16));
    if (!row || !safeEq(hash, row.pw_hash)) { fail('ip:' + ip); fail('user:' + username); throw new HttpError(401, 'Wrong username or password'); }
    attempts.delete('user:' + username);
    return send(res, 200, { username, token: await newSession(row.id, row.must_reset), mustChange: row.must_reset }, cors);
  }

  const user = await auth(req);

  if (user.restricted && route !== 'POST /api/logout' && route !== 'POST /api/password')
    throw new HttpError(403, 'Choose a new password first', { code: 'must_change' });

  if (route === 'POST /api/logout') {
    await pool.query('DELETE FROM sessions WHERE token_hash=$1', [user.tokenHash]);
    return send(res, 200, { ok: true }, cors);
  }

  if (route === 'POST /api/password') {
    throttle('pw:' + user.id, 10);
    if (!validPw(body.newPassword)) throw new HttpError(400, 'New password must be at least 8 characters');
    const row = (await pool.query('SELECT pw_salt, pw_hash FROM users WHERE id=$1', [user.id])).rows[0];
    if (!safeEq(await scrypt(String(body.password || ''), row.pw_salt), row.pw_hash)) { fail('pw:' + user.id); throw new HttpError(401, 'Current password is wrong'); }
    if (safeEq(body.password, body.newPassword)) throw new HttpError(400, 'Choose a different password from the current one');
    const salt = crypto.randomBytes(16).toString('hex');
    await pool.query('UPDATE users SET pw_salt=$1, pw_hash=$2, must_reset=false WHERE id=$3', [salt, await scrypt(body.newPassword, salt), user.id]);
    await pool.query('UPDATE sessions SET restricted=false WHERE token_hash=$1', [user.tokenHash]);
    await pool.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [user.id, user.tokenHash]); // sign out other devices
    return send(res, 200, { ok: true }, cors);
  }

  if (route === 'GET /api/library') {
    const r = await pool.query('SELECT data, rev FROM libraries WHERE user_id=$1', [user.id]);
    const row = r.rows[0];
    // data is stored text; embed it as-is so key order is preserved.
    return send(res, 200, row ? '{"rev":' + row.rev + ',"data":' + row.data + '}' : '{"rev":0,"data":null}', cors);
  }

  if (route === 'PUT /api/library') {
    const expected = Number(req.headers['if-match']);
    if (!Number.isInteger(expected) || expected < 0) throw new HttpError(428, 'If-Match revision required');
    const lib = body.data;
    if (!lib || typeof lib !== 'object' || !Array.isArray(lib.entries) || !Array.isArray(lib.franchises || [])) throw new HttpError(400, 'Not a Marginalia library');
    const text = JSON.stringify(lib);
    if (text.length > MAX_LIBRARY_CHARS) throw new HttpError(413, 'Library exceeds 10 million characters');
    let rev = null;
    if (expected === 0) {
      const r = await pool.query('INSERT INTO libraries(user_id,data,rev) VALUES($1,$2,1) ON CONFLICT DO NOTHING RETURNING rev', [user.id, text]);
      rev = r.rows[0] && r.rows[0].rev;
    } else {
      const r = await pool.query('UPDATE libraries SET data=$2, rev=rev+1, updated=now() WHERE user_id=$1 AND rev=$3 RETURNING rev', [user.id, text, expected]);
      rev = r.rows[0] && r.rows[0].rev;
    }
    if (rev == null) throw new HttpError(409, 'Library changed on another device');
    return send(res, 200, { rev }, cors);
  }

  throw new HttpError(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') return send(res, 204, '', cors);
      return await api(req, res, url);
    }
    if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
    if ((url.pathname === '/' || url.pathname === '/index.html') && (req.method === 'GET' || req.method === 'HEAD'))
      return send(res, 200, req.method === 'HEAD' ? '' : page, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, Object.assign({ error: e.message }, e.extra), cors);
    console.error(e);
    return send(res, 500, { error: 'Server error' }, cors);
  }
});

init().then(() => server.listen(PORT, () => console.log('Marginalia listening on ' + PORT)))
  .catch(e => { console.error('Startup failed', e); process.exit(1); });
