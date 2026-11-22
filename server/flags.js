'use strict';
// Manage feature flags. Needs DATABASE_URL (use the Postgres public URL from your own computer).
//
//   node flags.js list                          all flags, their defaults and per-user overrides
//   node flags.js show <user>                   the flags that user actually gets
//   node flags.js on <flag> <user>              turn a flag on for one user
//   node flags.js off <flag> <user>             turn a flag off for one user
//   node flags.js clear <flag> <user>           remove the override (user follows the default again)
//   node flags.js default on|off <flag>         change the default for everyone without an override
//   node flags.js default clear <flag>          fall back to the code default
//
// Users pick changes up on their next sync (within about a minute, or when they reopen the app).
const { Pool } = require('pg');
const { FLAG_DEFAULTS, SCHEMA, validFlag, resolveFlags } = require('./features');

const [cmd, a, b] = process.argv.slice(2);
const usage = () => { console.error(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 12).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(2); };
const onOff = v => v === 'on' ? true : v === 'off' ? false : null;

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(SCHEMA);
    const userId = async name => {
      const r = await pool.query('SELECT id FROM users WHERE username=$1', [String(name || '').trim().toLowerCase()]);
      if (!r.rows[0]) { console.error('No account named "' + name + '".'); process.exit(1); }
      return r.rows[0].id;
    };
    const needFlag = f => { if (!validFlag(f)) { console.error('Flag names are lowercase letters, digits and _ (e.g. new_editor).'); process.exit(2); } };

    if (cmd === 'list') {
      const defaults = new Map((await pool.query('SELECT flag, enabled FROM feature_defaults')).rows.map(r => [r.flag, r.enabled]));
      const ov = (await pool.query('SELECT f.flag, f.enabled, u.username FROM user_features f JOIN users u ON u.id=f.user_id ORDER BY f.flag, u.username')).rows;
      const names = new Set([...Object.keys(FLAG_DEFAULTS), ...defaults.keys(), ...ov.map(r => r.flag)]);
      for (const f of [...names].sort()) {
        const base = f in FLAG_DEFAULTS ? (FLAG_DEFAULTS[f] ? 'on' : 'off') : '(not in code)';
        const db = defaults.has(f) ? (defaults.get(f) ? 'on' : 'off') : '-';
        const users = ov.filter(r => r.flag === f).map(r => r.username + '=' + (r.enabled ? 'on' : 'off')).join(', ') || '-';
        console.log(f.padEnd(20) + ' code:' + base.padEnd(13) + ' db default:' + db.padEnd(4) + ' users: ' + users);
      }
    } else if (cmd === 'show' && a) {
      const flags = await resolveFlags(pool, await userId(a));
      for (const f of Object.keys(flags).sort()) console.log(f.padEnd(20) + (flags[f] ? 'on' : 'off'));
    } else if ((cmd === 'on' || cmd === 'off') && a && b) {
      needFlag(a);
      await pool.query('INSERT INTO user_features(user_id,flag,enabled) VALUES($1,$2,$3) ON CONFLICT (user_id,flag) DO UPDATE SET enabled=$3, updated=now()', [await userId(b), a, cmd === 'on']);
      console.log('"' + a + '" is ' + cmd + ' for ' + b + '.');
    } else if (cmd === 'clear' && a && b) {
      needFlag(a);
      const r = await pool.query('DELETE FROM user_features WHERE user_id=$1 AND flag=$2', [await userId(b), a]);
      console.log(r.rowCount ? 'Override removed for ' + b + '.' : b + ' had no override for "' + a + '".');
    } else if (cmd === 'default' && a && b) {
      needFlag(b);
      if (a === 'clear') { await pool.query('DELETE FROM feature_defaults WHERE flag=$1', [b]); console.log('"' + b + '" now follows the code default.'); }
      else if (onOff(a) !== null) { await pool.query('INSERT INTO feature_defaults(flag,enabled) VALUES($1,$2) ON CONFLICT (flag) DO UPDATE SET enabled=$2, updated=now()', [b, onOff(a)]); console.log('Default for "' + b + '" is ' + a + ' for everyone without an override.'); }
      else usage();
    } else usage();
  } finally { await pool.end(); }
})().catch(e => { console.error(e.message); process.exit(1); });
