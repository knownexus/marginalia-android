'use strict';
// Grant or revoke admin access from the command line (the admin page does the rest).
//   node admin.js list
//   node admin.js grant <user>
//   node admin.js revoke <user>
// Needs DATABASE_URL. You can also set the ADMIN_USERS variable (comma-separated usernames) on the server.
const { Pool } = require('pg');
const [cmd, who] = process.argv.slice(2);
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (cmd === 'list') {
      for (const r of (await pool.query('SELECT username, is_admin FROM users ORDER BY username')).rows) console.log(r.username.padEnd(34) + (r.is_admin ? 'admin' : ''));
    } else if ((cmd === 'grant' || cmd === 'revoke') && who) {
      const r = await pool.query('UPDATE users SET is_admin=$1 WHERE username=$2 RETURNING username', [cmd === 'grant', who.trim().toLowerCase()]);
      console.log(r.rows[0] ? r.rows[0].username + (cmd === 'grant' ? ' is now an admin.' : ' is no longer an admin.') : 'No account named "' + who + '".');
      if (!r.rows[0]) process.exitCode = 1;
    } else { console.error('Usage: node admin.js list | grant <user> | revoke <user>'); process.exitCode = 2; }
  } finally { await pool.end(); }
})().catch(e => { console.error(e.message); process.exit(1); });
