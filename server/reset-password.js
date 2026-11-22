'use strict';
// Flag an account so its next sign-in must choose a new password. All of its sessions are ended.
// The library is untouched.
//
//   Forgot password (sets a temporary one, printed once):
//     DATABASE_URL=... node reset-password.js <username>
//   Choose the temporary password yourself (8+ characters):
//     DATABASE_URL=... TEMP_PASSWORD=... node reset-password.js <username>
//   Force a change but keep the current password:
//     DATABASE_URL=... node reset-password.js <username> --flag-only
//
// The user signs in with the temporary (or current) password and is asked to choose a new one.
// Same scrypt settings as index.js.
const crypto = require('crypto');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const flagOnly = args.includes('--flag-only');
const username = String(args.find(a => !a.startsWith('--')) || '').trim().toLowerCase();
const given = process.env.TEMP_PASSWORD || '';
if (!username || (given && (given.length < 8 || given.length > 200))) {
  console.error('Usage: DATABASE_URL=... [TEMP_PASSWORD=<8+ characters>] node reset-password.js <username> [--flag-only]');
  process.exit(2);
}
const scrypt = (pw, salt) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k.toString('hex'))));

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS must_reset BOOLEAN NOT NULL DEFAULT false');
    let r, temp = null;
    if (flagOnly) {
      r = await pool.query('UPDATE users SET must_reset=true WHERE username=$1 RETURNING id', [username]);
    } else {
      temp = given || crypto.randomBytes(9).toString('base64url');
      const salt = crypto.randomBytes(16).toString('hex');
      r = await pool.query('UPDATE users SET pw_salt=$1, pw_hash=$2, must_reset=true WHERE username=$3 RETURNING id', [salt, await scrypt(temp, salt), username]);
    }
    if (!r.rows[0]) { console.error('No account named "' + username + '".'); process.exitCode = 1; return; }
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [r.rows[0].id]);
    console.log('"' + username + '" must choose a new password at next sign-in. All of its devices were signed out; the library is untouched.');
    if (temp && !given) console.log('Temporary password (shown once): ' + temp);
  } finally { await pool.end(); }
})().catch(e => { console.error(e.message); process.exit(1); });
