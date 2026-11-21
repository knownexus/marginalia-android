package com.marginalia.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.AtomicFile
import java.io.File
import java.security.MessageDigest
import org.json.JSONObject

class DocumentRepository(private val context: Context) {
    private val prefs = context.getSharedPreferences("library", Context.MODE_PRIVATE)
    private val snapshot = AtomicFile(File(context.filesDir, "library.json"))
    private val resolver = context.contentResolver
    private val empty = """{"version":1,"entries":[],"franchises":[],"deleted":{}}"""
    fun current(): String = if (snapshot.baseFile.exists() || File(snapshot.baseFile.path+".bak").exists()) snapshot.readFully().toString(Charsets.UTF_8) else empty
    private fun digest(s: String) = android.util.Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(s.toByteArray()),2)
    fun read(uri: Uri): String {
        val stream = resolver.openInputStream(uri) ?: error("File unavailable")
        return stream.bufferedReader().use { reader ->
            val text = StringBuilder()
            val buf = CharArray(8192)
            while (true) {
                val n = reader.read(buf)
                if (n < 0) break
                require(text.length+n <= 20_000_000) { "File exceeds 20 MB" }
                text.append(buf,0,n)
            }
            text.toString()
        }
    }
    fun export(uri: Uri, json: String) {
        resolver.openOutputStream(uri,"wt")?.use { it.write(json.toByteArray()) } ?: error("Cannot write this file")
        check(read(uri)==json) { "File verification failed" }
    }
    @Synchronized fun bind(uri: Uri) {
        resolver.takePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        val json = current()
        export(uri,json)
        prefs.edit().putString("uri",uri.toString()).putString("digest",digest(json)).commit()
    }
    @Synchronized fun save(json: String): String {
        require(json.length <= 20_000_000) { "Library exceeds 20 million characters" }
        JSONObject(json).getJSONArray("entries")
        val stream = snapshot.startWrite()
        try { stream.write(json.toByteArray()); snapshot.finishWrite(stream) }
        catch(e:Exception){snapshot.failWrite(stream);throw e}
        val uri = prefs.getString("uri",null)?.let(Uri::parse) ?: return "Saved on device"
        return runCatching {
            val previous = read(uri)
            check(digest(previous)==prefs.getString("digest","") || previous==json) { "Linked file changed. Import it, then create a fresh linked file." }
            export(uri,json)
            prefs.edit().putString("digest",digest(json)).commit()
            "Saved on device and to file"
        }.getOrElse { "Saved on device only. "+it.message }
    }
    fun linked(): Boolean = prefs.contains("uri")
}
