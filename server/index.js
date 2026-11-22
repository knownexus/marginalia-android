'use strict';
// Marginalia server: serves the single-file page and a small account + library API.
// The server stores one JSON library per account. Merging happens in the client
// (same rules as Import), so the server only needs optimistic concurrency (If-Match).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { SCHEMA: FEATURE_SCHEMA, FLAG_DEFAULTS, validFlag, resolveFlags } = require('./features');

const PORT = Number(process.env.PORT) || 8080;
const INVITE_CODE = process.env.INVITE_CODE || '';
const INDEX_PATH = process.env.INDEX_PATH || path.join(__dirname, 'index.html');
const WEB_DIR = process.env.WEB_DIR || path.join(__dirname, 'web');
const ADMIN_USERS = (process.env.ADMIN_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const MAX_VERSIONS = 40;           // snapshots kept per account
const SNAPSHOT_EVERY_MIN = 15;     // at most one routine snapshot per account in this window
const MAX_BODY = 12 * 1024 * 1024;
const MAX_LIBRARY_CHARS = 10_000_000;
const SESSION_DAYS = 90;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const page = fs.readFileSync(INDEX_PATH);
// Installable-app files, served from the site root. Missing files are simply not served.
const STATIC = {};
for (const [name, type] of [['manifest.webmanifest', 'application/manifest+json'], ['sw.js', 'text/javascript; charset=utf-8'],
  ['icon.svg', 'image/svg+xml'], ['icon-192.png', 'image/png'], ['icon-512.png', 'image/png'], ['icon-maskable-512.png', 'image/png']]) {
  try { STATIC['/' + name] = { body: fs.readFileSync(path.join(WEB_DIR, name)), type }; } catch { /* optional */ }
}

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
  await pool.query(FEATURE_SCHEMA);
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS library_versions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      entries INTEGER NOT NULL,
      franchises INTEGER NOT NULL,
      as_of TIMESTAMPTZ NOT NULL,
      taken TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS library_versions_user ON library_versions(user_id, id DESC);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  if (ADMIN_USERS.length) await pool.query('UPDATE users SET is_admin=true WHERE username = ANY($1)', [ADMIN_USERS]);
}

// Invite code: a value set from the admin page wins; otherwise the INVITE_CODE variable. Empty means closed.
async function inviteCode() {
  const r = await pool.query("SELECT value FROM settings WHERE key='invite_code'");
  return r.rows[0] ? r.rows[0].value : INVITE_CODE;
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
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Max-Age': '86400' };

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
  const r = await pool.query('SELECT u.id, u.username, u.is_admin, u.last_seen, s.restricted FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires>now()', [sha(m[1])]);
  if (!r.rows[0]) throw new HttpError(401, 'Session expired. Sign in again.');
  const u = r.rows[0];
  if (!u.last_seen || Date.now() - new Date(u.last_seen).getTime() > 5 * 60 * 1000) pool.query('UPDATE users SET last_seen=now() WHERE id=$1', [u.id]).catch(() => {});
  return { id: u.id, username: u.username, isAdmin: u.is_admin, restricted: u.restricted, tokenHash: sha(m[1]) };
}


// Replace a library if its revision still matches, snapshotting the state being replaced when
// it is worth keeping (forced, a shrinking library, or none taken recently). Returns the new rev or null on conflict.
async function writeLibrary(userId, expected, text, newEntries, force) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const cur = (await c.query('SELECT data, rev, updated FROM libraries WHERE user_id=$1 FOR UPDATE', [userId])).rows[0];
    if ((cur ? cur.rev : 0) !== expected) { await c.query('ROLLBACK'); return null; }
    let rev;
    if (!cur) {
      rev = (await c.query('INSERT INTO libraries(user_id,data,rev) VALUES($1,$2,1) RETURNING rev', [userId, text])).rows[0].rev;
    } else {
      let old = null; try { old = JSON.parse(cur.data); } catch { /* keep going without a snapshot */ }
      if (old && (old.entries.length || (old.franchises || []).length) && cur.data !== text) {
        const recent = (await c.query("SELECT 1 FROM library_versions WHERE user_id=$1 AND taken > now() - ($2 || ' minutes')::interval LIMIT 1", [userId, String(SNAPSHOT_EVERY_MIN)])).rows[0];
        const latest = (await c.query('SELECT data FROM library_versions WHERE user_id=$1 ORDER BY id DESC LIMIT 1', [userId])).rows[0];
        if ((force || newEntries < old.entries.length || !recent) && !(latest && latest.data === cur.data)) {
          await c.query('INSERT INTO library_versions(user_id,data,entries,franchises,as_of) VALUES($1,$2,$3,$4,$5)', [userId, cur.data, old.entries.length, (old.franchises || []).length, cur.updated]);
          await c.query('DELETE FROM library_versions WHERE user_id=$1 AND id NOT IN (SELECT id FROM library_versions WHERE user_id=$1 ORDER BY id DESC LIMIT $2)', [userId, MAX_VERSIONS]);
        }
      }
      rev = (await c.query('UPDATE libraries SET data=$2, rev=rev+1, updated=now() WHERE user_id=$1 RETURNING rev', [userId, text])).rows[0].rev;
    }
    await c.query('COMMIT');
    return rev;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* already closed */ }
    if (e.code === '23505') return null; // a concurrent first write won
    throw e;
  } finally { c.release(); }
}

const tempPassword = () => crypto.randomBytes(9).toString('base64url');
async function setTempPassword(id, pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  await pool.query('UPDATE users SET pw_salt=$1, pw_hash=$2, must_reset=true WHERE id=$3', [salt, await scrypt(pw, salt), id]);
  await pool.query('DELETE FROM sessions WHERE user_id=$1', [id]);
}

async function admin(req, res, url, body, me) {
  const log = what => console.log('[admin] ' + me.username + ' ' + what);
  const route = req.method + ' ' + url.pathname;
  const target = async idStr => {
    const r = await pool.query('SELECT id, username FROM users WHERE id=$1', [idStr]);
    if (!r.rows[0]) throw new HttpError(404, 'No such account');
    return r.rows[0];
  };

  if (route === 'GET /api/admin/overview') {
    const code = await inviteCode();
    const defaults = (await pool.query('SELECT flag, enabled FROM feature_defaults')).rows;
    const users = (await pool.query(`
      SELECT u.id, u.username, u.created, u.last_seen, u.must_reset, u.is_admin,
        l.rev, l.updated AS lib_updated, length(l.data)::int AS bytes,
        jsonb_array_length((l.data::jsonb)->'entries') AS entries,
        jsonb_array_length(COALESCE((l.data::jsonb)->'franchises','[]'::jsonb)) AS franchises,
        (SELECT count(*)::int FROM sessions s WHERE s.user_id=u.id AND s.expires>now()) AS sessions,
        (SELECT count(*)::int FROM library_versions v WHERE v.user_id=u.id) AS versions
      FROM users u LEFT JOIN libraries l ON l.user_id=u.id ORDER BY u.username`)).rows;
    const overrides = (await pool.query('SELECT user_id, flag, enabled FROM user_features')).rows;
    return send(res, 200, {
      registrationOpen: !!code, inviteCode: code,
      flags: { code: FLAG_DEFAULTS, db: Object.fromEntries(defaults.map(d => [d.flag, d.enabled])) },
      users: users.map(u => ({
        id: Number(u.id), username: u.username, created: u.created, lastSeen: u.last_seen, mustReset: u.must_reset, isAdmin: u.is_admin,
        entries: u.entries, franchises: u.franchises, bytes: u.bytes, libraryUpdated: u.lib_updated, sessions: u.sessions, versions: u.versions,
        overrides: Object.fromEntries(overrides.filter(o => Number(o.user_id) === Number(u.id)).map(o => [o.flag, o.enabled]))
      }))
    }, cors);
  }

  if (route === 'POST /api/admin/invite') {
    if (body.action === 'rotate') {
      const code = crypto.randomBytes(9).toString('base64url');
      await pool.query("INSERT INTO settings(key,value) VALUES('invite_code',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [code]);
      log('rotated the invite code');
      return send(res, 200, { registrationOpen: true, inviteCode: code }, cors);
    }
    if (body.action === 'close') {
      await pool.query("INSERT INTO settings(key,value) VALUES('invite_code','') ON CONFLICT (key) DO UPDATE SET value=''");
      log('closed registration');
      return send(res, 200, { registrationOpen: false, inviteCode: '' }, cors);
    }
    throw new HttpError(400, 'Unknown action');
  }

  if (route === 'PUT /api/admin/features/default') {
    if (!validFlag(body.flag)) throw new HttpError(400, 'Bad flag name');
    if (body.enabled === null) await pool.query('DELETE FROM feature_defaults WHERE flag=$1', [body.flag]);
    else await pool.query('INSERT INTO feature_defaults(flag,enabled) VALUES($1,$2) ON CONFLICT (flag) DO UPDATE SET enabled=$2, updated=now()', [body.flag, !!body.enabled]);
    log('set the default of ' + body.flag + ' to ' + body.enabled);
    return send(res, 200, { ok: true }, cors);
  }

  const m = /^\/api\/admin\/users\/(\d+)(?:\/([a-z-]+))?$/.exec(url.pathname);
  if (m) {
    const t = await target(m[1]), action = m[2] || '';
    const self = Number(t.id) === Number(me.id);
    if (req.method === 'DELETE' && !action) {
      if (self) throw new HttpError(400, 'You cannot delete your own account here');
      await pool.query('DELETE FROM users WHERE id=$1', [t.id]);
      log('deleted ' + t.username);
      return send(res, 200, { ok: true }, cors);
    }
    if (req.method === 'POST' && action === 'reset-password') {
      const pw = tempPassword(); await setTempPassword(t.id, pw);
      log('reset the password of ' + t.username);
      return send(res, 200, { temporaryPassword: pw }, cors);
    }
    if (req.method === 'POST' && action === 'force-change') {
      await pool.query('UPDATE users SET must_reset=true WHERE id=$1', [t.id]);
      await pool.query('DELETE FROM sessions WHERE user_id=$1', [t.id]);
      log('required a password change for ' + t.username);
      return send(res, 200, { ok: true }, cors);
    }
    if (req.method === 'POST' && action === 'sign-out') {
      await pool.query('DELETE FROM sessions WHERE user_id=$1', [t.id]);
      log('signed out ' + t.username + ' everywhere');
      return send(res, 200, { ok: true }, cors);
    }
    if (req.method === 'POST' && action === 'admin') {
      if (self) throw new HttpError(400, 'You cannot change your own admin access');
      await pool.query('UPDATE users SET is_admin=$1 WHERE id=$2', [!!body.value, t.id]);
      log((body.value ? 'made ' : 'removed admin from ') + t.username);
      return send(res, 200, { ok: true }, cors);
    }
    if (req.method === 'PUT' && action === 'features') {
      if (!validFlag(body.flag)) throw new HttpError(400, 'Bad flag name');
      if (body.enabled === null) await pool.query('DELETE FROM user_features WHERE user_id=$1 AND flag=$2', [t.id, body.flag]);
      else await pool.query('INSERT INTO user_features(user_id,flag,enabled) VALUES($1,$2,$3) ON CONFLICT (user_id,flag) DO UPDATE SET enabled=$3, updated=now()', [t.id, body.flag, !!body.enabled]);
      log('set ' + body.flag + ' to ' + body.enabled + ' for ' + t.username);
      return send(res, 200, { ok: true }, cors);
    }
  }
  throw new HttpError(404, 'Not found');
}

/* ---------- routes ---------- */
async function api(req, res, url) {
  const route = req.method + ' ' + url.pathname;
  const body = req.method === 'GET' ? {} : await readBody(req);

  if (route === 'POST /api/register') {
    const ip = clientIp(req); throttle('reg:' + ip, 10); 
    const code = await inviteCode();
    if (!code) throw new HttpError(403, 'Registration is closed');
    const username = String(body.username || '').trim().toLowerCase();
    if (!safeEq(sha(String(body.invite || '')), sha(code))) { fail('reg:' + ip); throw new HttpError(403, 'Invite code not recognised'); }
    if (!validName(username)) throw new HttpError(400, 'Username must be 3-32 characters: letters, numbers, . _ -');
    if (!validPw(body.password)) throw new HttpError(400, 'Password must be at least 8 characters');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await scrypt(body.password, salt);
    let id;
    try { id = (await pool.query('INSERT INTO users(username,pw_salt,pw_hash) VALUES($1,$2,$3) RETURNING id', [username, salt, hash])).rows[0].id; }
    catch (e) { if (e.code === '23505') throw new HttpError(409, 'That username is taken'); throw e; }
    const isAdmin = ADMIN_USERS.includes(username);
    if (isAdmin) await pool.query('UPDATE users SET is_admin=true WHERE id=$1', [id]);
    return send(res, 200, { username, token: await newSession(id), mustChange: false, isAdmin, features: await resolveFlags(pool, id) }, cors);
  }

  if (route === 'POST /api/login') {
    const username = String(body.username || '').trim().toLowerCase(), ip = clientIp(req);
    throttle('ip:' + ip, 40); throttle('user:' + username, 10);
    const r = await pool.query('SELECT id, pw_salt, pw_hash, must_reset, is_admin FROM users WHERE username=$1', [username]);
    const row = r.rows[0];
    // Always hash, so unknown usernames cost the same as wrong passwords.
    const hash = await scrypt(String(body.password || ''), row ? row.pw_salt : '00'.repeat(16));
    if (!row || !safeEq(hash, row.pw_hash)) { fail('ip:' + ip); fail('user:' + username); throw new HttpError(401, 'Wrong username or password'); }
    attempts.delete('user:' + username);
    return send(res, 200, { username, token: await newSession(row.id, row.must_reset), mustChange: row.must_reset, isAdmin: row.is_admin, features: await resolveFlags(pool, row.id) }, cors);
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
    const features = JSON.stringify(await resolveFlags(pool, user.id));
    return send(res, 200, row ? '{"rev":' + row.rev + ',"data":' + row.data + ',"features":' + features + ',"isAdmin":' + user.isAdmin + '}' : '{"rev":0,"data":null,"features":' + features + ',"isAdmin":' + user.isAdmin + '}', cors);
  }

  if (route === 'PUT /api/library') {
    const expected = Number(req.headers['if-match']);
    if (!Number.isInteger(expected) || expected < 0) throw new HttpError(428, 'If-Match revision required');
    const lib = body.data;
    if (!lib || typeof lib !== 'object' || !Array.isArray(lib.entries) || !Array.isArray(lib.franchises || [])) throw new HttpError(400, 'Not a Marginalia library');
    const text = JSON.stringify(lib);
    if (text.length > MAX_LIBRARY_CHARS) throw new HttpError(413, 'Library exceeds 10 million characters');
    const rev = await writeLibrary(user.id, expected, text, lib.entries.length, url.searchParams.get('snapshot') === '1');
    if (rev == null) throw new HttpError(409, 'Library changed on another device');
    return send(res, 200, { rev }, cors);
  }

  /* ----- version history ----- */
  if (route === 'GET /api/versions') {
    const r = await pool.query('SELECT id, as_of, entries, franchises, length(data) AS bytes FROM library_versions WHERE user_id=$1 ORDER BY id DESC LIMIT $2', [user.id, MAX_VERSIONS]);
    return send(res, 200, { versions: r.rows.map(v => ({ id: Number(v.id), asOf: v.as_of, entries: v.entries, franchises: v.franchises, bytes: Number(v.bytes) })) }, cors);
  }
  let m = /^\/api\/versions\/(\d+)$/.exec(url.pathname);
  if (m && req.method === 'GET') {
    const r = await pool.query('SELECT id, as_of, data FROM library_versions WHERE id=$1 AND user_id=$2', [m[1], user.id]);
    if (!r.rows[0]) throw new HttpError(404, 'Version not found');
    return send(res, 200, '{"id":' + r.rows[0].id + ',"asOf":' + JSON.stringify(r.rows[0].as_of) + ',"data":' + r.rows[0].data + '}', cors);
  }

  /* ----- admin ----- */
  if (url.pathname.startsWith('/api/admin/')) {
    if (!user.isAdmin) throw new HttpError(403, 'Admins only');
    return admin(req, res, url, body, user);
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
    const st = STATIC[url.pathname];
    if (st && (req.method === 'GET' || req.method === 'HEAD'))
      return send(res, 200, req.method === 'HEAD' ? '' : st.body, { 'Content-Type': st.type, 'Cache-Control': 'no-cache' });
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
