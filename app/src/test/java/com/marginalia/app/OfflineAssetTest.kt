package com.marginalia.app

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Test

class OfflineAssetTest {
    @Test fun `bundled page has no remote resource URLs`() {
        val page = File("src/main/assets/index.html").readText()
        assertFalse("Remote resource", Regex("""(?:src|href)=["']https?://""").containsMatchIn(page))
        val js = page.replace("\r\n","\n").substringAfter("<script>").substringBefore("</script>")
        val hash = java.util.Base64.getEncoder().encodeToString(java.security.MessageDigest.getInstance("SHA-256").digest(js.toByteArray()))
        org.junit.Assert.assertTrue("Bundled script matches policy", page.contains("'sha256-"+hash+"'"))
    }
}
