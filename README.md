# Marginalia for Android

Copy Marginalia.apk to an Android 8 or newer device and tap it in Files to install. If Android prompts, allow that file manager to install this APK. The app runs offline.

### Move a library

For a new library, start with the [editable JSON template](examples/marginalia-template.json).

In your original HTML tracker, open Settings and export its JSON backup. In the Android app, open **Settings & files → Import and merge**. Select individual records or the whole backup, review the counts and tap **Apply merge**. Cancel leaves the library as it was.

The app saves edits on the device. **Link a new file** creates a portable JSON copy and updates it after each save. Use **Export backup** for a separate snapshot or **Share backup** to send it to another device. If another app edits the linked copy, Marginalia keeps your device copy and shows a warning. Import the changed file to reconcile it, then link a fresh file.

Different record IDs survive a merge. For edits to the same record, the newer timestamp wins. A deletion wins when equally recent or newer. These rules apply to whole records, including their notes. Independent entries with the same title stay separate. Export before uninstalling to keep a portable backup.

### Filter the library

Open **Library → Sort and filter**. Include or exclude values in each section. **Match all** requires every included genre or year within that section. **Match any** accepts one. Exclusions always win. Tap an active filter to remove it, or use **Clear all**.

### Build from source

Open the extracted project in Android Studio with SDK Platform 35 installed. Build a debug APK or run `gradlew.bat :app:testDebugUnitTest :app:assembleDebug` on Windows. On macOS or Linux use `sh gradlew :app:testDebugUnitTest :app:assembleDebug`. The APK is written to `app/build/outputs/apk/debug/`. First-time builds download dependencies.
