'use strict';
// Marginalia server: serves the single-file page and a small account + library API.
// The server stores one JSON library per account. Merging happens in the client
// (same rules as Import), so the server only needs optimistic concurrency (If-Match).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { parseWork } = require('./ao3');
const { SCHEMA: FEATURE_SCHEMA, FLAG_DEFAULTS, validFlag, resolveFlags, featureOn } = require('./features');

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
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shares (
      token TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      with_notes BOOLEAN NOT NULL DEFAULT false,
      created TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS shares_user ON shares(user_id);`);
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
const cors2 = type => Object.assign({}, cors, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' });
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


/* ---------- read-only share links ---------- */
const MAX_SHARES = 50;
// What a share exposes. Notes only when the owner ticked "include notes". Never links, tombstones or other accounts' data.
function shareView(lib, share) {
  const keep = e => ({
    id: e.id, type: e.type, title: e.title, creator: e.creator || '', status: e.status, stars: e.stars == null ? null : e.stars,
    feeling: e.feeling || '', genres: e.genres || [], dates: (e.dates || []).map(r => ({ start: r.start || '', end: r.end || '' })),
    cover: typeof e.cover === 'string' && e.cover.startsWith('data:image/') ? e.cover : '',
    url: typeof e.url === 'string' && /^https?:\/\//i.test(e.url) ? e.url : '',
    details: e.details || {}, notes: share.with_notes ? (e.notes || '') : ''
  });
  const entries = lib.entries || [];
  const out = { kind: share.kind, title: share.title, withNotes: share.with_notes };
  if (share.kind === 'franchise') {
    const f = (lib.franchises || []).find(x => x.id === share.ref);
    if (!f) return null;
    const mine = entries.filter(e => e.franchiseId === f.id), ids = new Set(mine.map(e => e.id));
    out.title = f.name; out.notes = share.with_notes ? (f.notes || '') : '';
    out.timelines = (f.timelines || []).map(t => ({ name: t.name, items: (t.items || []).filter(i => ids.has(i.entryId)).map(i => ({ entryId: i.entryId, note: i.note || '' })) }));
    out.entries = mine.map(keep);
  } else if (share.kind === 'list') {
    const l = (lib.lists || []).find(x => x.id === share.ref);
    if (!l) return null;
    out.title = l.name; out.notes = share.with_notes ? (l.notes || '') : '';
    out.entries = entries.filter(e => (e.listIds || []).includes(l.id)).map(keep);
  } else {
    out.entries = entries.map(keep);
  }
  return out;
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


/* ---------- cover lookup (flag: cover_fetch) ---------- */
// The page cannot reach image sites itself (its security policy only allows this server), so the server looks a cover
// up and hands the image bytes back. Only these fixed hosts are ever contacted; the caller supplies search words, never a URL.
const COVER_UP = Object.assign({ audible: 'https://api.audible.com', ol: 'https://openlibrary.org', olcovers: 'https://covers.openlibrary.org', gb: 'https://www.googleapis.com' },
  process.env.COVER_UPSTREAM_TEST ? JSON.parse(process.env.COVER_UPSTREAM_TEST) : {});   // the override is for tests only
const COVER_IMAGE_HOSTS = /(^|\.)(media-amazon\.com|ssl-images-amazon\.com|openlibrary\.org|archive\.org|books\.google\.com|googleusercontent\.com)$/;
const MAX_COVER_BYTES = 2 * 1024 * 1024, COVER_PER_HOUR = 600;
const coverUse = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of coverUse) if (v.reset < t) coverUse.delete(k); }, 60_000).unref();
function coverQuota(userId) {
  const t = Date.now(); let a = coverUse.get(userId);
  if (!a || a.reset < t) { a = { n: 0, reset: t + 3600_000 }; coverUse.set(userId, a); }
  if (++a.n > COVER_PER_HOUR) throw new HttpError(429, 'Cover lookups are limited to ' + COVER_PER_HOUR + ' an hour. Try again later.');
}
async function getJson(u) {
  try { const r = await fetch(u, { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function getImage(u) {
  let x; try { x = new URL(u); } catch { return null; }
  if (x.protocol === 'http:' && !process.env.COVER_UPSTREAM_TEST) x.protocol = 'https:';
  if (!process.env.COVER_UPSTREAM_TEST && !COVER_IMAGE_HOSTS.test(x.hostname)) return null;
  try {
    const r = await fetch(x, { signal: AbortSignal.timeout(15000) });
    const type = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!r.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > 1000 && buf.length <= MAX_COVER_BYTES ? { type, buf } : null;   // tiny files are placeholders
  } catch { return null; }
}
async function findCover(title, creator, asin) {
  if (asin) {
    const j = await getJson(COVER_UP.audible + '/1.0/catalog/products/' + asin + '?response_groups=media');
    const imgs = j && j.product && j.product.product_images;
    const u = imgs && (imgs['500'] || imgs['252'] || Object.values(imgs)[0]);
    if (u) { const im = await getImage(u); if (im) return im; }
  }
  if (title) {
    const q = new URLSearchParams({ title, limit: '3', fields: 'cover_i' }); if (creator) q.set('author', creator);
    const j = await getJson(COVER_UP.ol + '/search.json?' + q);
    for (const d of (j && j.docs) || []) {
      if (!Number.isInteger(d.cover_i)) continue;
      const im = await getImage(COVER_UP.olcovers + '/b/id/' + d.cover_i + '-M.jpg?default=false'); if (im) return im;
    }
    const g = await getJson(COVER_UP.gb + '/books/v1/volumes?maxResults=3&q=' + encodeURIComponent('intitle:' + title + (creator ? ' inauthor:' + creator : '')));
    for (const it of (g && g.items) || []) {
      const l = it.volumeInfo && it.volumeInfo.imageLinks, u = l && (l.thumbnail || l.smallThumbnail);
      if (u) { const im = await getImage(String(u).replace('&edge=curl', '')); if (im) return im; }
    }
  }
  return null;
}

/* ---------- AO3 lookup (flag: ao3_fetch) ---------- */
// The page cannot read archiveofourown.org itself, so the server fetches the public work page and returns its details.
// AO3 throttles automated readers, so this is deliberately slow and gentle: one request at a time with a gap between them,
// a shared cool-down when AO3 says "slow down" (and one automatic retry after its Retry-After), and a one-hour cache so
// the same story is never fetched twice.
const AO3_BASE = process.env.AO3_BASE_TEST || 'https://archiveofourown.org';
const TESTING_AO3 = !!process.env.AO3_BASE_TEST;
const AO3_PER_HOUR = 800, AO3_GAP_MS = TESTING_AO3 ? 0 : 5000, AO3_MAX_WAIT_S = 30, AO3_CACHE_MS = 3600_000, AO3_CACHE_MAX = 1000;
const ao3Use = new Map(), ao3Cache = new Map(), ao3Flight = new Map();
let ao3Chain = Promise.resolve(), ao3CoolUntil = 0;
function ao3Quota(userId) {
  const t = Date.now(); let a = ao3Use.get(userId);
  if (!a || a.reset < t) { a = { n: 0, reset: t + 3600_000 }; ao3Use.set(userId, a); }
  if (++a.n > AO3_PER_HOUR) throw new HttpError(429, 'AO3 lookups are limited to ' + AO3_PER_HOUR + ' an hour. Try again later.', { retryAfter: 600 });
}
function ao3Slot() {   // one request at a time, with a gap between them
  const run = ao3Chain.then(() => null), done = run.then(() => new Promise(r => setTimeout(r, AO3_GAP_MS)));
  ao3Chain = done; return run;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function retryAfterSeconds(r) {
  const h = r.headers.get('retry-after'); if (!h) return 0;
  const n = Number(h); if (Number.isFinite(n)) return Math.max(0, Math.ceil(n));
  const d = Date.parse(h); return Number.isFinite(d) ? Math.max(0, Math.ceil((d - Date.now()) / 1000)) : 0;
}
const slowDown = secs => new HttpError(429, 'AO3 asked us to slow down. Try again in about ' + Math.max(10, secs) + ' seconds.', { retryAfter: Math.max(10, secs) });
async function ao3Request(id) {
  return fetch(AO3_BASE + '/works/' + id + '?view_adult=true&view_full_work=false', { signal: AbortSignal.timeout(20000), redirect: 'follow',
    headers: { 'User-Agent': 'Marginalia/1.0 (personal reading tracker)', Accept: 'text/html' } });
}
async function fetchWorkUncached(id) {
  await ao3Slot();
  const wait0 = Math.ceil((ao3CoolUntil - Date.now()) / 1000);
  if (wait0 > AO3_MAX_WAIT_S) throw slowDown(wait0);
  if (wait0 > 0) await sleep(wait0 * 1000);
  let r;
  for (let attempt = 0; ; attempt++) {
    try { r = await ao3Request(id); } catch { throw new HttpError(502, 'Could not reach AO3'); }
    if (r.status !== 429) break;
    const ra = retryAfterSeconds(r) || 30;
    ao3CoolUntil = Date.now() + Math.max(ra, 30) * 1000;
    if (attempt === 1 || ra > AO3_MAX_WAIT_S) throw slowDown(Math.max(ra, 60));
    await sleep(ra * 1000);   // one automatic retry after the wait AO3 asked for
  }
  if (r.status === 404) throw new HttpError(404, 'AO3 has no work with that number');
  if (r.status === 403 || r.status === 503) throw new HttpError(502, 'AO3 refused the request (it may be blocking automated lookups from this server)');
  if (!r.ok) throw new HttpError(502, 'AO3 answered with status ' + r.status);
  const html = (await r.text()).slice(0, 3_000_000);
  try { return parseWork(html); }
  catch (e) { throw new HttpError(e.code === 'restricted' ? 403 : 502, e.message); }
}
async function fetchWork(id) {
  const hit = ao3Cache.get(id);
  if (hit && hit.t > Date.now()) return hit.w;
  if (ao3Flight.has(id)) return ao3Flight.get(id);   // the same story asked for twice at once is fetched once
  const p = fetchWorkUncached(id).then(w => {
    ao3Cache.set(id, { w, t: Date.now() + AO3_CACHE_MS });
    if (ao3Cache.size > AO3_CACHE_MAX) ao3Cache.delete(ao3Cache.keys().next().value);
    return w;
  }).finally(() => ao3Flight.delete(id));
  ao3Flight.set(id, p); return p;
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


  {
    const sm = /^GET \/api\/shared\/([A-Za-z0-9_-]{10,40})$/.exec(route);
    if (sm) {
      const key = 'shared:' + clientIp(req); throttle(key, 300); fail(key);
      const sh = (await pool.query('SELECT s.kind, s.ref, s.title, s.with_notes, l.data, l.updated FROM shares s JOIN libraries l ON l.user_id=s.user_id WHERE s.token=$1', [sm[1]])).rows[0];
      const view = sh && shareView(JSON.parse(sh.data), sh);
      if (!view) throw new HttpError(404, 'This link is no longer available');
      view.updated = sh.updated;
      return send(res, 200, view, Object.assign({ 'X-Robots-Tag': 'noindex, nofollow' }, cors));
    }
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

  /* ----- cover lookup ----- */
  if (route === 'GET /api/cover') {
    if (!(await featureOn(pool, user.id, 'cover_fetch'))) throw new HttpError(403, 'Cover lookup is not turned on for this account');
    const title = String(url.searchParams.get('title') || '').trim().slice(0, 200);
    const creator = String(url.searchParams.get('creator') || '').trim().slice(0, 120);
    const asin = String(url.searchParams.get('asin') || '').trim().toUpperCase();
    if (asin && !/^[A-Z0-9]{10}$/.test(asin)) throw new HttpError(400, 'Not a valid ASIN');
    if (!title && !asin) throw new HttpError(400, 'A title is needed');
    coverQuota(user.id);
    const im = await findCover(title, creator, asin);
    if (!im) throw new HttpError(404, 'No cover found');
    return send(res, 200, im.buf, cors2(im.type));
  }

  /* ----- AO3 lookup ----- */
  if (route === 'GET /api/ao3') {
    if (!(await featureOn(pool, user.id, 'ao3_fetch'))) throw new HttpError(403, 'AO3 lookup is not turned on for this account');
    const id = String(url.searchParams.get('id') || '').trim();
    if (!/^\d{1,12}$/.test(id)) throw new HttpError(400, 'Not a valid AO3 work number');
    if (!ao3Cache.has(id) || ao3Cache.get(id).t <= Date.now()) ao3Quota(user.id);   // cache hits cost nothing
    const w = await fetchWork(id);
    return send(res, 200, Object.assign({ id, url: 'https://archiveofourown.org/works/' + id }, w), Object.assign({}, cors, { 'Cache-Control': 'private, max-age=3600' }));
  }

  /* ----- export everything (the parts the page does not already hold) ----- */
  if (route === 'GET /api/export') {
    const withVersions = url.searchParams.get('versions') === '1';
    const acct = (await pool.query('SELECT username, created, is_admin FROM users WHERE id=$1', [user.id])).rows[0];
    const shares = (await pool.query('SELECT token, kind, ref, title, with_notes, created FROM shares WHERE user_id=$1 ORDER BY created', [user.id])).rows;
    let versions = [];
    if (withVersions) {
      const r = await pool.query('SELECT id, as_of, entries, franchises, data FROM library_versions WHERE user_id=$1 ORDER BY id DESC', [user.id]);
      if (r.rows.reduce((n, v) => n + v.data.length, 0) > 60 * 1024 * 1024) throw new HttpError(413, 'Version history is too large to include. Export without it.');
      versions = r.rows;
    }
    // Versions are embedded as stored text so their key order is preserved.
    const body = '{"exportedAt":' + JSON.stringify(new Date().toISOString())
      + ',"account":' + JSON.stringify({ username: acct.username, created: acct.created, admin: acct.is_admin })
      + ',"features":' + JSON.stringify(await resolveFlags(pool, user.id))
      + ',"shares":' + JSON.stringify(shares.map(s => ({ token: s.token, kind: s.kind, ref: s.ref, title: s.title, withNotes: s.with_notes, created: s.created })))
      + ',"versions":[' + versions.map(v => '{"id":' + v.id + ',"asOf":' + JSON.stringify(v.as_of) + ',"entries":' + v.entries + ',"franchises":' + v.franchises + ',"data":' + v.data + '}').join(',') + ']}';
    return send(res, 200, body, cors);
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

  /* ----- share links (owner side) ----- */
  if (route === 'GET /api/shares') {
    const r = await pool.query('SELECT token, kind, ref, title, with_notes, created FROM shares WHERE user_id=$1 ORDER BY created DESC', [user.id]);
    return send(res, 200, { shares: r.rows.map(s => ({ token: s.token, kind: s.kind, ref: s.ref, title: s.title, withNotes: s.with_notes, created: s.created })) }, cors);
  }
  if (route === 'POST /api/shares') {
    if (!(await featureOn(pool, user.id, 'sharing'))) throw new HttpError(403, 'Sharing is not turned on for this account');
    const kind = body.kind, ref = String(body.ref || '');
    if (!['franchise', 'list', 'library'].includes(kind)) throw new HttpError(400, 'Unknown share type');
    if ((await pool.query('SELECT count(*)::int AS n FROM shares WHERE user_id=$1', [user.id])).rows[0].n >= MAX_SHARES) throw new HttpError(400, 'Too many share links. Revoke some first.');
    const row = (await pool.query('SELECT data FROM libraries WHERE user_id=$1', [user.id])).rows[0];
    if (!row) throw new HttpError(400, 'Sync your library first');
    const preview = shareView(JSON.parse(row.data), { kind, ref, title: 'My library', with_notes: false });
    if (!preview) throw new HttpError(404, 'That item is not in your synced library. Sync, then try again.');
    const token = crypto.randomBytes(16).toString('base64url');
    await pool.query('INSERT INTO shares(token,user_id,kind,ref,title,with_notes) VALUES($1,$2,$3,$4,$5,$6)', [token, user.id, kind, kind === 'library' ? '' : ref, preview.title, !!body.notes]);
    return send(res, 200, { token, title: preview.title }, cors);
  }
  m = /^\/api\/shares\/([A-Za-z0-9_-]{10,40})$/.exec(url.pathname);
  if (m && req.method === 'DELETE') {
    const r = await pool.query('DELETE FROM shares WHERE token=$1 AND user_id=$2', [m[1], user.id]);
    if (!r.rowCount) throw new HttpError(404, 'No such link');
    return send(res, 200, { ok: true }, cors);
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
