'use strict';
// Per-user feature flags.
// Resolution order, highest first:  user override  >  database default  >  code default (below).
// Everything that exists today is "on" by default, so an account with no override keeps all of it.
// To ship something new to chosen users only: add the flag here (or just in the page) with
// default false, deploy, then turn it on for those accounts with `node flags.js on <flag> <user>`.

const FLAG_DEFAULTS = {
  franchises: true,       // Franchises page, timelines and franchise links
  stats: true,            // Stats page
  wrapped: true,          // Year wrapped page
  file_link: true,        // Linked library file (desktop) and Link / Share backup (Android)
  shortcuts: true,        // Keyboard shortcuts
  drag_drop_import: true, // Drop a backup file on the page to import it
  // New functionality: off until switched on per account (admin page or `node flags.js on <flag> <user>`).
  version_history: false, // Restore earlier versions of the library from the server
  offline_app: false,     // Installable web app that opens offline
  quick_add: false,       // One-line quick add on Home
  sync_notices: false,    // Say what a sync merged and when edits conflicted
  covers: false,          // Cover images and a link on each entry
  progress: false,        // One-tap progress buttons (+10 pages, next episode, +1 h, finish)
  lists: false,           // Named lists beyond franchises
  stats_plus: false,      // Year-over-year, ratings by genre, pace chart, wrapped as an image
  import_trackers: false, // Import Goodreads, StoryGraph and Letterboxd exports (and generic CSV)
  sharing: false,         // Read-only share links for a franchise, a list or the whole library
  library_actions: false, // Library page: quick stars and Start/Finish, tap-to-filter chips, multi-select, preview panel
  next_up: false,         // Next unread book per series on Home, series order on franchise pages
  genre_manager: false,   // Tidy up: rename, merge and delete genres
  saved_views: false,     // Named filter sets on the Library page, pinnable to Home
  listening_stats: false, // Audiobook hours on the Stats page and in Year wrapped
  duplicates: false,      // Tidy up: find and merge duplicate entries
  export_all: false,      // Export everything: a zip with the library, a spreadsheet, covers, settings and account data
  undo: false,            // Undo toasts (and Ctrl+Z) instead of confirm dialogs for destructive actions
  editions: false         // Link entries as editions of one book (e.g. different narrators): one place in lists and counts, separate reviews
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS feature_defaults (
    flag TEXT PRIMARY KEY,
    enabled BOOLEAN NOT NULL,
    updated TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS user_features (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    flag TEXT NOT NULL,
    enabled BOOLEAN NOT NULL,
    updated TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, flag)
  );`;

const validFlag = f => typeof f === 'string' && /^[a-z][a-z0-9_]{1,40}$/.test(f);

async function resolveFlags(db, userId) {
  const [defaults, overrides] = await Promise.all([
    db.query('SELECT flag, enabled FROM feature_defaults'),
    db.query('SELECT flag, enabled FROM user_features WHERE user_id=$1', [userId])
  ]);
  const out = Object.assign({}, FLAG_DEFAULTS);
  for (const r of defaults.rows) out[r.flag] = r.enabled;
  for (const r of overrides.rows) out[r.flag] = r.enabled;
  return out;
}

// For gating server behaviour in future: `if (await featureOn(pool, user.id, 'some_flag')) ...`
async function featureOn(db, userId, flag) {
  return !!(await resolveFlags(db, userId))[flag];
}

module.exports = { FLAG_DEFAULTS, SCHEMA, validFlag, resolveFlags, featureOn };
