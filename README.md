# Marginalia for Android

Copy Marginalia.apk to an Android 8 or newer device and tap it in Files to install. If Android prompts, allow that file manager to install this APK. The app runs offline. Signing in to sync is optional.

### Move a library

For a new library, start with the [editable JSON template](examples/marginalia-template.json).

In your original HTML tracker, open Settings and export its JSON backup. In the Android app, open **Settings & files → Import and merge**. Select individual records or the whole backup, review the counts and tap **Apply merge**. Cancel leaves the library as it was.

The app saves edits on the device. **Link a new file** creates a portable JSON copy and updates it after each save. Use **Export backup** for a separate snapshot or **Share backup** to send it to another device. If another app edits the linked copy, Marginalia keeps your device copy and shows a warning. Import the changed file to reconcile it, then link a fresh file.

Different record IDs survive a merge. For edits to the same record, the newer timestamp wins. A deletion wins when equally recent or newer. These rules apply to whole records, including their notes. Independent entries with the same title stay separate. Export before uninstalling to keep a portable backup.

### Filter the library

Open **Library → Sort and filter**. Include or exclude values in each section. **Match all** requires every included genre or year within that section. **Match any** accepts one. Exclusions always win. Tap an active filter to remove it, or use **Clear all**.

### Accounts and sync

Sync is optional. Without signing in, the library stays on the device as before. In **Settings & files → Account & sync**, create an account (the server owner gives you an invite code) or sign in. The library is saved on the device first, then merged with the account using the same rules as **Import and merge**, so edits made offline are kept. Sign in on another device, or the desktop page, and they stay in step. Signing in as a different account on a device replaces that device's library with the new account's, after a confirmation, so profiles never mix.

`server/` is a small Node server that serves the page and stores one library per account in Postgres. Set `DATABASE_URL` and `INVITE_CODE` (registration is closed when it's unset) and run `node server/index.js`. The `Dockerfile` builds it. The Android app now has the Internet permission and reaches only the hosted address, enforced by the page's Content-Security-Policy. To use your own server, change the address in `index.html` (`API_BASE` and the CSP `connect-src`) and in the unit-test hash policy by editing the script as usual.

To reset a password, run `npm ci` in `server/`, then `DATABASE_URL=<database URL> node reset-password.js <username>`. Use the Postgres service's public URL from your own computer. It sets a random temporary password (printed once) and flags the account. At the next sign-in the user is asked to choose a new password, and nothing else works until they do. Add `--flag-only` to force a change without touching the current password, or set `TEMP_PASSWORD` to pick the temporary one. Either way the account is signed out everywhere and its library is untouched.

### Feature flags (per-user rollout)

Features can be switched on or off per account, so new functionality can reach chosen users first. A flag resolves in this order: the account's own setting, then the database default, then the default in the code. Everything that exists today defaults to on, so an account with no setting keeps it all. Signed-out use always follows the defaults in the page.

Current flags: `franchises`, `stats`, `wrapped`, `file_link`, `shortcuts`, `drag_drop_import` (all on by default) and `version_history`, `offline_app`, `quick_add`, `sync_notices`, `covers`, `progress`, `lists`, `stats_plus`, `import_trackers`, `sharing`, `library_actions` (off by default, so they reach only the accounts you switch them on for). Manage them with `server/flags.js` (same `DATABASE_URL` as the password script):

```
node flags.js list                       # every flag, its defaults and per-user settings
node flags.js show alice                 # what alice actually gets
node flags.js off stats alice            # turn a flag off for one account
node flags.js on new_editor alice        # turn a flag on for one account
node flags.js clear new_editor alice     # back to the default
node flags.js default on new_editor      # roll out to everyone without a setting
```

To ship something new to chosen users: add the flag in `index.html` (`FEATURES`, as `false`), wrap the feature in `feat('new_editor')`, deploy, then `node flags.js on new_editor <user>`. Accounts pick up changes at their next sync, within about a minute or when they reopen the app. Flags hide features in the page. They don't enforce anything on the server, which can check a flag with `featureOn()` in `server/features.js` when needed. By hand in SQL: `INSERT INTO user_features(user_id,flag,enabled) SELECT id,'new_editor',true FROM users WHERE username='alice' ON CONFLICT (user_id,flag) DO UPDATE SET enabled=true;`

### Admin, history, offline app, quick add and sync notices

- **Admin page** (`#/admin`, only for accounts marked admin; enforced on the server). Create the first admin by setting the `ADMIN_USERS` variable on the server to a username (comma-separate several), or with `node admin.js grant <user>`. Admins can reset a password (a temporary one is shown once and the user must change it at next sign-in), require a password change, sign someone out everywhere, make or remove admins, delete an account, turn feature flags on or off per account or for everyone, and rotate or close the invite code. Admins see counts and sizes, never anyone's entries.
- **Version history** (flag `version_history`). The server keeps up to 40 snapshots per account: at most one every 15 minutes while you edit, always before a change that removes entries, and always before a restore. **Settings → Version history → Restore** brings an earlier snapshot back on every signed-in device (restored records get fresh timestamps so the merge accepts them), and today's library stays as a version, so a restore can be undone.
- **Installable offline app** (flag `offline_app`). Adds a web manifest and a service worker so Chrome, Edge and phones can install the site and open it offline. The page comes from the network when it can and from the cache when it can't. Sync calls are never cached. Turning the flag off removes both.
- **Quick add** (flag `quick_add`). One line on Home, for example `Dune by Frank Herbert, book, finished, 4 stars, #scifi, in Dune saga, 2026-03-12`. Details after the title are matched by what they look like: a type (book, film, tv, game, play, escape, online), a status (planned, reading, finished…), a rating (`4 stars`, `4.5/5`, `4*`), `#genres`, `in Franchise`, `by Creator`, and `today`, `yesterday` or a date. Anything else becomes a note. `q` jumps to it.
- **Sync notices** (flag `sync_notices`). When a sync brings in changes it says what changed, and when the same record was edited on two devices it says which version won (the newer edit). **Settings → Recent sync activity** keeps the last 25.

### More features (all behind flags)

- **Covers and links** (`covers`). Add a cover image and a web link to any entry in the editor. Covers are shrunk in the browser to about 10 KB and stored in the library, so about 600 fit before the library nears its 10 MB limit (the editor refuses past 8 MB). Links must be `http` or `https`; anything else is discarded. In the Android app a link opens in the system browser.
- **Progress buttons** (`progress`). On Home and on an entry: **+10 pages**, **+25 pages**, **Next episode** (`S2E5` becomes `S2E6`, `12/24` becomes `13/24`), **+1 h**, **+5 h**, **Start** and **Finish**. Finishing stamps today's date.
- **Lists** (`lists`). Named collections that cut across franchises ("to read this winter", "recommended by Sam"). Add entries from a list's page or an entry's page, filter the Library by list, and add `list: Name` to a quick-add line. Two devices that create a list with the same name offline are merged into one.
- **More stats** (`stats_plus`). Finished per year by type with the change on the year before, average stars by genre and by type, finished per month over the last year, and **Year wrapped → Save as image** (a PNG in the browser and desktop app; not in the Android app).
- **Import from other trackers** (`import_trackers`). Goodreads, StoryGraph, Letterboxd and Audible exports and any CSV with a Title column, through the same review screen as Import and merge. For Audible, export your library with [Libation](https://github.com/rmcrackan/Libation) as JSON or CSV. Each audiobook becomes a book with format Audiobook, its narrator and length (two extra book fields shown while this flag is on), a link to its Audible page, genres from its categories, the date added as its date added, a rating where you gave one, and finished or planned from Libation's finished flag (the export has no finish dates). Series become franchises when you own two or more books in them; the series and volume also go in the Series / volume field. Sleep and podcast episodes and returned, unfinished books are skipped. Imported records are stamped old on purpose, so importing the same file twice adds nothing, your own edits win, and anything you deleted stays deleted.
- **Share links** (`sharing`, enforced on the server). A read-only link to a franchise, a list or the whole library that anyone can open without an account. It shows your current library and stops working when you revoke it. Notes are shared only if you tick **include my notes**. Entry links, food-scale ratings, franchise and list membership, and deleted records are never included. Manage links in **Settings → Share links**.

- **Library actions** (`library_actions`). Makes the Library page interactive. Each card has tappable stars (tap the same star again to clear), **Start** and **Finish** (or **Already finished**, which marks a book finished without inventing a date) and an **Add to list** menu. Tap a genre, franchise or status chip to filter to it, and tap again to clear; cards show three genres plus a **+N** button that opens the rest. Tick cards to select them and a sticky bar offers set status, add to list, add or remove a genre, and delete (it warns when selected books are hidden by a filter, and, with Version history on, that deleted books can be restored). Clicking a card opens a preview panel (a bottom sheet on phones) with its details and the same actions, so you keep your place; Esc closes it.

### Desktop app (Windows, macOS, Linux)

`desktop/` is an Electron wrapper around the same page, so it works offline and signs in to the same account for sync. Links open in your browser, and the window only ever shows the app page. It keeps its library in the app's own storage, so it uses account sync and Export backup rather than the browser's linked file.

```
cd desktop
npm install
npm start          # run it
npm run dist       # build an installer for the current OS (dmg, nsis or AppImage/deb)
```

The **Desktop app** workflow builds all three on GitHub (run it from the Actions tab). Installers aren't code-signed, so Windows SmartScreen and macOS Gatekeeper will ask you to confirm the first launch.

### Use it on desktop

Hosted at https://web-production-ac96f798.up.railway.app (Railway, built from the `Dockerfile` in this repo). Your library stays in your own browser. Opening the address on a new device starts empty, so move data with export and import.

To run it locally instead:

The app is a single offline page, so it also runs in a desktop browser. Open `app/src/main/assets/index.html` in Chrome or Edge (or copy that one file anywhere and open it). Nothing is uploaded.

- **Same library as your phone:** use **Export backup** on one side and **Import and merge** on the other. You can also drop a backup `.json` file onto the page.
- **Linked file:** in **Settings & files**, **Link a file** saves a JSON copy after every edit, the same way the Android app does. The browser asks permission again after a restart, so use **Reconnect file**. If another app or device changes the linked file, Marginalia keeps your browser copy and warns you. Import the file, then link a fresh one. Browsers without this feature (Firefox, Safari) keep the library in the browser only, so export backups regularly.
- **Keyboard:** `/` search, `n` log something, `Ctrl`/`Cmd`+`S` or `Ctrl`/`Cmd`+`Enter` save the open entry, `Esc` close.
- Wide windows use extra columns, and the entry page shows details beside notes.

### Build from source

Open the extracted project in Android Studio with SDK Platform 35 installed. Build a debug APK or run `gradlew.bat :app:testDebugUnitTest :app:assembleDebug` on Windows. On macOS or Linux use `sh gradlew :app:testDebugUnitTest :app:assembleDebug`. The APK is written to `app/build/outputs/apk/debug/`. First-time builds download dependencies.
