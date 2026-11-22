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

Current flags: `franchises`, `stats`, `wrapped`, `file_link`, `shortcuts`, `drag_drop_import`. Manage them with `server/flags.js` (same `DATABASE_URL` as the password script):

```
node flags.js list                       # every flag, its defaults and per-user settings
node flags.js show alice                 # what alice actually gets
node flags.js off stats alice            # turn a flag off for one account
node flags.js on new_editor alice        # turn a flag on for one account
node flags.js clear new_editor alice     # back to the default
node flags.js default on new_editor      # roll out to everyone without a setting
```

To ship something new to chosen users: add the flag in `index.html` (`FEATURES`, as `false`), wrap the feature in `feat('new_editor')`, deploy, then `node flags.js on new_editor <user>`. Accounts pick up changes at their next sync, within about a minute or when they reopen the app. Flags hide features in the page. They don't enforce anything on the server, which can check a flag with `featureOn()` in `server/features.js` when needed. By hand in SQL: `INSERT INTO user_features(user_id,flag,enabled) SELECT id,'new_editor',true FROM users WHERE username='alice' ON CONFLICT (user_id,flag) DO UPDATE SET enabled=true;`

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
