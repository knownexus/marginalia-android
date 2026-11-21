package com.marginalia.app

import android.webkit.JavascriptInterface

class MarginaliaBridge(private val host: MainActivity, private val repo: DocumentRepository) {
    @JavascriptInterface fun load(): String = repo.current()
    @JavascriptInterface fun save(json: String): String = runCatching { repo.save(json) }.getOrElse { "Save failed. "+it.message }
    @JavascriptInterface fun linked(): Boolean = repo.linked()
    @JavascriptInterface fun action(name: String) { host.runOnUiThread { host.fileAction(name) } }
}
