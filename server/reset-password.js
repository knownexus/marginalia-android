'use strict';
// Reset an account's password and sign it out everywhere.
// Usage: DATABASE_URL=... NEW_PASSWORD='at least 8 characters' node reset-password.js <username>
// Same scrypt settings as index.js. The password is read from the environment so it stays out of the process list.
const crypto = require('crypto');
const { Pool } = require('pg');

const username = String(process.argv[2] || '').trim().toLowerCase();
const password = process.env.NEW_PASSWORD || '';
if (!username || password.length < 8 || password.length > 200) {
  console.error('Usage: DATABASE_URL=... NEW_PASSWORD=<8+ characters> node reset-password.js <username>');
  process.exit(2);
}
const scrypt = (pw, salt) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k.toString('hex'))));

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const salt = crypto.randomBytes(16).toString('hex');
    const r = await pool.query('UPDATE users SET pw_salt=$1, pw_hash=$2 WHERE username=$3 RETURNING id', [salt, await scrypt(password, salt), username]);
    if (!r.rows[0]) { console.error('No account named "' + username + '".'); process.exitCode = 1; return; }
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [r.rows[0].id]);
    console.log('Password reset for "' + username + '". All of its devices were signed out; the library is untouched.');
  } finally { await pool.end(); }
})().catch(e => { console.error(e.message); process.exit(1); });
